import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisSnapshotSummary, ProjectAnalysis, StoredAnalysisSnapshot } from '../shared/graph.js';

const MAX_SNAPSHOTS = 50;

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

export class SnapshotStore {
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
    `);
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
