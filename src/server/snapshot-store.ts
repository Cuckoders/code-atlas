import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisSnapshotSummary, ProjectAnalysis, StoredAnalysisSnapshot } from '../shared/graph.js';
import {
  MAX_BLUEPRINT_JSON_SIZE,
  validateArchitectureBlueprint,
  type ArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
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
          ORDER BY created_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(MAX_SNAPSHOTS);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return summary;
  }

  list(limit = 12): AnalysisSnapshotSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_SNAPSHOTS));
    const rows = this.database.prepare(`
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
