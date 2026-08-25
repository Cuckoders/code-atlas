import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisSnapshotSummary, ProjectAnalysis, StoredAnalysisSnapshot } from '../shared/graph.js';
import type { RuntimeTraceSession, RuntimeTraceSummary } from '../shared/runtime-trace.js';
import {
  MAX_BLUEPRINT_JSON_SIZE,
  validateArchitectureBlueprint,
  type ArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
  type BlueprintDocument,
  type BlueprintDocumentSummary,
} from '../shared/blueprint.js';
import {
  MAX_PARSE_CACHE_JSON_SIZE,
  PARSER_CACHE_VERSION,
  parseCachedSource,
  type ParseCache,
} from './parse-cache.js';
import type { ParsedSource } from './tree-sitter-parser.js';

const MAX_SNAPSHOTS = 50;
const MAX_PARSED_FILES = 15_000;
const MAX_RUNTIME_TRACES_PER_PROJECT = 100;

interface SnapshotRow {
  id: string;
  created_at: string;
  project_name: string;
  project_path: string;
  compare_ref: string | null;
  files_scanned: number;
  node_count: number;
  edge_count: number;
  duration_ms: number;
  analysis_json?: string;
}

interface RuntimeTraceRow {
  id: string;
  project_path: string;
  trace_id: string;
  name: string;
  created_at: string;
  started_at: string;
  duration_ms: number;
  status: 'unset' | 'ok' | 'error';
  span_count: number;
  error_count: number;
  service_names_json: string;
  trace_json?: string;
}

interface BlueprintDocumentRow {
  id: string;
  project_path: string;
  name: string;
  created_at: string;
  updated_at: string;
  blueprint_json: string;
}

export class SnapshotStore implements ParseCache {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS analysis_snapshots (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        compare_ref TEXT,
        files_scanned INTEGER NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        analysis_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analysis_snapshots_created_at
        ON analysis_snapshots(created_at DESC);
      CREATE INDEX IF NOT EXISTS analysis_snapshots_project_created_at
        ON analysis_snapshots(project_path, created_at DESC);
      CREATE TABLE IF NOT EXISTS parsed_sources (
        project_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        parsed_json TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (project_path, relative_path, content_hash, parser_version)
      );
      CREATE INDEX IF NOT EXISTS parsed_sources_last_used_at
        ON parsed_sources(last_used_at DESC);
      CREATE TABLE IF NOT EXISTS architecture_blueprints (
        project_path TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        blueprint_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS architecture_blueprint_documents (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        blueprint_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS architecture_blueprint_documents_project_updated
        ON architecture_blueprint_documents(project_path, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runtime_traces (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('unset', 'ok', 'error')),
        span_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        service_names_json TEXT NOT NULL,
        trace_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_traces_project_created_at
        ON runtime_traces(project_path, created_at DESC);
    `);
  }

  getParsedSource(projectPath: string, relativePath: string, contentHash: string): ParsedSource | null {
    const row = this.database.prepare(`
      SELECT parsed_json
      FROM parsed_sources
      WHERE project_path = ? AND relative_path = ? AND content_hash = ? AND parser_version = ?
    `).get(projectPath, relativePath, contentHash, PARSER_CACHE_VERSION) as { parsed_json?: unknown } | undefined;
    if (typeof row?.parsed_json !== 'string') return null;
    const parsed = parseCachedSource(row.parsed_json);
    if (!parsed) return null;
    this.database.prepare(`
      UPDATE parsed_sources SET last_used_at = ?
      WHERE project_path = ? AND relative_path = ? AND content_hash = ? AND parser_version = ?
    `).run(new Date().toISOString(), projectPath, relativePath, contentHash, PARSER_CACHE_VERSION);
    return parsed;
  }

  setParsedSource(projectPath: string, relativePath: string, contentHash: string, parsed: ParsedSource): void {
    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PARSE_CACHE_JSON_SIZE) return;
    this.database.prepare(`
      INSERT INTO parsed_sources (
        project_path, relative_path, content_hash, parser_version, parsed_json, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path, relative_path, content_hash, parser_version)
      DO UPDATE SET parsed_json = excluded.parsed_json, last_used_at = excluded.last_used_at
    `).run(
      projectPath,
      relativePath,
      contentHash,
      PARSER_CACHE_VERSION,
      serialized,
      new Date().toISOString(),
    );
  }

  pruneParsedSources(): void {
    this.database.prepare(`
      DELETE FROM parsed_sources
      WHERE rowid IN (
        SELECT rowid FROM parsed_sources
        ORDER BY last_used_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_PARSED_FILES);
  }

  save(analysis: ProjectAnalysis, compareRef?: string): AnalysisSnapshotSummary {
    const summary: AnalysisSnapshotSummary = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      projectName: analysis.summary.name,
      projectPath: analysis.summary.rootPath,
      ...(compareRef ? { compareRef } : {}),
      filesScanned: analysis.summary.filesScanned,
      nodeCount: analysis.nodes.length,
      edgeCount: analysis.edges.length,
      durationMs: analysis.summary.durationMs,
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO analysis_snapshots (
          id, created_at, project_name, project_path, compare_ref,
          files_scanned, node_count, edge_count, duration_ms, analysis_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summary.id,
        summary.createdAt,
        summary.projectName,
        summary.projectPath,
        summary.compareRef ?? null,
        summary.filesScanned,
        summary.nodeCount,
        summary.edgeCount,
        summary.durationMs,
        JSON.stringify(analysis),
      );
      this.database.prepare(`
        DELETE FROM analysis_snapshots
        WHERE id IN (
          SELECT id FROM analysis_snapshots
          WHERE project_path = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(summary.projectPath, MAX_SNAPSHOTS);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return summary;
  }

  list(limit = 12, projectPath?: string): AnalysisSnapshotSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_SNAPSHOTS));
    const rows = projectPath ? this.database.prepare(`
      SELECT id, created_at, project_name, project_path, compare_ref,
             files_scanned, node_count, edge_count, duration_ms
      FROM analysis_snapshots
      WHERE project_path = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectPath, safeLimit) as unknown as SnapshotRow[] : this.database.prepare(`
      SELECT id, created_at, project_name, project_path, compare_ref,
             files_scanned, node_count, edge_count, duration_ms
      FROM analysis_snapshots
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(safeLimit) as unknown as SnapshotRow[];
    return rows.map(toSummary);
  }

  get(id: string): StoredAnalysisSnapshot | null {
    const row = this.database.prepare(`
      SELECT id, created_at, project_name, project_path, compare_ref,
             files_scanned, node_count, edge_count, duration_ms, analysis_json
      FROM analysis_snapshots
      WHERE id = ?
    `).get(id) as unknown as SnapshotRow | undefined;
    if (!row?.analysis_json) return null;
    return {
      snapshot: toSummary(row),
      analysis: JSON.parse(row.analysis_json) as ProjectAnalysis,
    };
  }

  saveBlueprint(draft: ArchitectureBlueprintDraft): ArchitectureBlueprint {
    const blueprint: ArchitectureBlueprint = { ...draft, updatedAt: new Date().toISOString() };
    const validationError = validateArchitectureBlueprint(blueprint, true);
    if (validationError) throw new Error(validationError);
    const serialized = JSON.stringify(blueprint);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BLUEPRINT_JSON_SIZE) {
      throw new Error('Blueprint слишком большой.');
    }
    this.database.prepare(`
      INSERT INTO architecture_blueprints (project_path, updated_at, blueprint_json)
      VALUES (?, ?, ?)
      ON CONFLICT(project_path)
      DO UPDATE SET updated_at = excluded.updated_at, blueprint_json = excluded.blueprint_json
    `).run(blueprint.projectPath, blueprint.updatedAt, serialized);
    return blueprint;
  }

  getBlueprint(projectPath: string): ArchitectureBlueprint | null {
    const row = this.database.prepare(`
      SELECT blueprint_json FROM architecture_blueprints WHERE project_path = ?
    `).get(projectPath) as { blueprint_json?: unknown } | undefined;
    if (typeof row?.blueprint_json !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(row.blueprint_json);
      return validateArchitectureBlueprint(parsed, true) ? null : parsed as ArchitectureBlueprint;
    } catch {
      return null;
    }
  }

  listBlueprintDocuments(projectPath: string): BlueprintDocumentSummary[] {
    this.migrateLegacyBlueprint(projectPath);
    const rows = this.database.prepare(`
      SELECT id, project_path, name, created_at, updated_at, blueprint_json
      FROM architecture_blueprint_documents
      WHERE project_path = ?
      ORDER BY updated_at DESC, rowid DESC
    `).all(projectPath) as unknown as BlueprintDocumentRow[];
    return rows.flatMap((row) => {
      const blueprint = parseStoredBlueprint(row.blueprint_json);
      return blueprint ? [{
        id: row.id,
        projectPath: row.project_path,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nodeCount: blueprint.nodes.length,
        edgeCount: blueprint.edges.length,
      }] : [];
    });
  }

  getBlueprintDocument(projectPath: string, id: string): BlueprintDocument | null {
    this.migrateLegacyBlueprint(projectPath);
    const row = this.database.prepare(`
      SELECT id, project_path, name, created_at, updated_at, blueprint_json
      FROM architecture_blueprint_documents
      WHERE project_path = ? AND id = ?
    `).get(projectPath, id) as unknown as BlueprintDocumentRow | undefined;
    if (!row) return null;
    const blueprint = parseStoredBlueprint(row.blueprint_json);
    return blueprint ? {
      ...blueprint,
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  saveBlueprintDocument(name: string, draft: ArchitectureBlueprintDraft, id?: string): BlueprintDocument {
    const normalizedName = validateBlueprintName(name);
    const validationError = validateArchitectureBlueprint(draft);
    if (validationError) throw new Error(validationError);
    const serialized = JSON.stringify(draft);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BLUEPRINT_JSON_SIZE) throw new Error('Blueprint слишком большой.');
    const documentId = id ?? randomUUID();
    const existing = this.database.prepare(`
      SELECT project_path, created_at FROM architecture_blueprint_documents WHERE id = ?
    `).get(documentId) as { project_path?: unknown; created_at?: unknown } | undefined;
    if (typeof existing?.project_path === 'string' && existing.project_path !== draft.projectPath) {
      throw new Error('Blueprint относится к другому проекту.');
    }
    const now = new Date().toISOString();
    const createdAt = typeof existing?.created_at === 'string' ? existing.created_at : now;
    this.database.prepare(`
      INSERT INTO architecture_blueprint_documents (id, project_path, name, created_at, updated_at, blueprint_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at,
        blueprint_json = excluded.blueprint_json
    `).run(documentId, draft.projectPath, normalizedName, createdAt, now, serialized);
    return { ...draft, id: documentId, name: normalizedName, createdAt, updatedAt: now };
  }

  renameBlueprintDocument(projectPath: string, id: string, name: string): BlueprintDocument | null {
    const normalizedName = validateBlueprintName(name);
    const updatedAt = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE architecture_blueprint_documents SET name = ?, updated_at = ?
      WHERE project_path = ? AND id = ?
    `).run(normalizedName, updatedAt, projectPath, id);
    return result.changes > 0 ? this.getBlueprintDocument(projectPath, id) : null;
  }

  duplicateBlueprintDocument(projectPath: string, id: string, name: string): BlueprintDocument | null {
    const source = this.getBlueprintDocument(projectPath, id);
    if (!source) return null;
    return this.saveBlueprintDocument(name, {
      version: source.version,
      projectPath: source.projectPath,
      nodes: source.nodes,
      edges: source.edges,
    });
  }

  deleteBlueprintDocument(projectPath: string, id: string): boolean {
    return this.database.prepare(`
      DELETE FROM architecture_blueprint_documents WHERE project_path = ? AND id = ?
    `).run(projectPath, id).changes > 0;
  }

  private migrateLegacyBlueprint(projectPath: string): void {
    const existing = this.database.prepare(`
      SELECT 1 FROM architecture_blueprint_documents WHERE project_path = ? LIMIT 1
    `).get(projectPath);
    if (existing) return;
    const legacy = this.getBlueprint(projectPath);
    if (!legacy) return;
    this.saveBlueprintDocument('Основной blueprint', {
      version: legacy.version,
      projectPath: legacy.projectPath,
      nodes: legacy.nodes,
      edges: legacy.edges,
    });
  }

  saveRuntimeTraces(sessions: RuntimeTraceSession[]): RuntimeTraceSummary[] {
    if (!sessions.length) return [];
    const insert = this.database.prepare(`
      INSERT INTO runtime_traces (
        id, project_path, trace_id, name, created_at, started_at, duration_ms,
        status, span_count, error_count, service_names_json, trace_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const session of sessions) {
        const summary = session.summary;
        insert.run(
          summary.id,
          summary.projectPath,
          summary.traceId,
          summary.name,
          summary.createdAt,
          summary.startedAt,
          summary.durationMs,
          summary.status,
          summary.spanCount,
          summary.errorCount,
          JSON.stringify(summary.serviceNames),
          JSON.stringify(session),
        );
        this.database.prepare(`
          DELETE FROM runtime_traces
          WHERE project_path = ? AND id IN (
            SELECT id FROM runtime_traces
            WHERE project_path = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT -1 OFFSET ?
          )
        `).run(summary.projectPath, summary.projectPath, MAX_RUNTIME_TRACES_PER_PROJECT);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return sessions.map((session) => session.summary);
  }

  listRuntimeTraces(projectPath: string, limit = 20): RuntimeTraceSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const rows = this.database.prepare(`
      SELECT id, project_path, trace_id, name, created_at, started_at, duration_ms,
             status, span_count, error_count, service_names_json
      FROM runtime_traces
      WHERE project_path = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectPath, safeLimit) as unknown as RuntimeTraceRow[];
    return rows.map(toRuntimeTraceSummary);
  }

  getRuntimeTrace(id: string): RuntimeTraceSession | null {
    const row = this.database.prepare(`
      SELECT trace_json FROM runtime_traces WHERE id = ?
    `).get(id) as { trace_json?: unknown } | undefined;
    if (typeof row?.trace_json !== 'string') return null;
    try {
      return JSON.parse(row.trace_json) as RuntimeTraceSession;
    } catch {
      return null;
    }
  }

  close(): void {
    this.database.close();
  }
}

function toSummary(row: SnapshotRow): AnalysisSnapshotSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    projectName: row.project_name,
    projectPath: row.project_path,
    ...(row.compare_ref ? { compareRef: row.compare_ref } : {}),
    filesScanned: row.files_scanned,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    durationMs: row.duration_ms,
  };
}

function parseStoredBlueprint(serialized: string): ArchitectureBlueprintDraft | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return validateArchitectureBlueprint(parsed) ? null : parsed as ArchitectureBlueprintDraft;
  } catch {
    return null;
  }
}

function validateBlueprintName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 128 || /[\0\r\n]/.test(normalized)) throw new Error('Некорректное название blueprint.');
  return normalized;
}

function toRuntimeTraceSummary(row: RuntimeTraceRow): RuntimeTraceSummary {
  let serviceNames: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.service_names_json);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) serviceNames = parsed;
  } catch {
    // A corrupted optional label must not prevent the remaining trace history from loading.
  }
  return {
    id: row.id,
    projectPath: row.project_path,
    traceId: row.trace_id,
    name: row.name,
    createdAt: row.created_at,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    status: row.status,
    spanCount: row.span_count,
    errorCount: row.error_count,
    serviceNames,
  };
}
