import path from 'node:path';
import type { AnalysisProgress, ProjectAnalysis } from '../shared/graph.js';
import { validateParsedSource } from './parse-cache.js';
import type { ParsedSource } from './tree-sitter-parser.js';

export interface AnalysisWorkerData {
  projectPath: string;
  compareRef?: string;
}

export type WorkerToMainMessage =
  | { type: 'progress'; progress: AnalysisProgress }
  | { type: 'cache-get'; requestId: string; projectPath: string; relativePath: string; contentHash: string }
  | { type: 'cache-set'; requestId: string; projectPath: string; relativePath: string; contentHash: string; parsed: ParsedSource }
  | { type: 'result'; analysis: ProjectAnalysis }
  | { type: 'failure'; operational: boolean; message: string; diagnostic?: string };

export type MainToWorkerMessage = {
  type: 'cache-response';
  requestId: string;
  ok: boolean;
  parsed?: ParsedSource | null;
};

const GIT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^\d{1,12}$/;
const PROGRESS_PHASES = new Set(['scanning', 'parsing', 'comparing', 'finalizing']);

export function validateWorkerData(value: unknown): AnalysisWorkerData | null {
  if (!isRecord(value) || !safeString(value.projectPath, 4_096) || value.projectPath.includes('\0')) return null;
  if (value.compareRef !== undefined && (
    !safeString(value.compareRef, 128) || !GIT_REFERENCE.test(value.compareRef)
  )) return null;
  return {
    projectPath: value.projectPath,
    ...(typeof value.compareRef === 'string' ? { compareRef: value.compareRef } : {}),
  };
}

export function validateWorkerMessage(value: unknown): WorkerToMainMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'progress') {
    const progress = validateProgress(value.progress);
    return progress ? { type: 'progress', progress } : null;
  }
  if (value.type === 'cache-get' || value.type === 'cache-set') {
    if (!validCacheCoordinates(value)) return null;
    if (value.type === 'cache-get') {
      return {
        type: 'cache-get',
        requestId: value.requestId,
        projectPath: value.projectPath,
        relativePath: value.relativePath,
        contentHash: value.contentHash,
      };
    }
    const parsed = validateParsedSource(value.parsed);
    return parsed ? {
      type: 'cache-set',
      requestId: value.requestId,
      projectPath: value.projectPath,
      relativePath: value.relativePath,
      contentHash: value.contentHash,
      parsed,
    } : null;
  }
  if (value.type === 'result') {
    return isProjectAnalysis(value.analysis) ? { type: 'result', analysis: value.analysis } : null;
  }
  if (value.type === 'failure') {
    if (typeof value.operational !== 'boolean' || !safeString(value.message, 1_000)) return null;
    if (value.diagnostic !== undefined && !safeString(value.diagnostic, 4_000)) return null;
    return {
      type: 'failure',
      operational: value.operational,
      message: value.message,
      ...(typeof value.diagnostic === 'string' ? { diagnostic: value.diagnostic } : {}),
    };
  }
  return null;
}

export function validateMainMessage(value: unknown): MainToWorkerMessage | null {
  if (!isRecord(value) || value.type !== 'cache-response' || typeof value.ok !== 'boolean') return null;
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) return null;
  if (value.parsed === undefined || value.parsed === null) {
    return { type: 'cache-response', requestId: value.requestId, ok: value.ok, parsed: null };
  }
  const parsed = validateParsedSource(value.parsed);
  return parsed ? { type: 'cache-response', requestId: value.requestId, ok: value.ok, parsed } : null;
}

export function isCachePathAllowed(projectPath: string, expectedProjectPath: string, relativePath: string): boolean {
  if (projectPath !== expectedProjectPath || !safeString(relativePath, 4_096)) return false;
  return !path.posix.isAbsolute(relativePath)
    && !relativePath.includes('\\')
    && !relativePath.split('/').includes('..');
}

function validCacheCoordinates(value: Record<string, unknown>): value is Record<string, unknown> & {
  requestId: string;
  projectPath: string;
  relativePath: string;
  contentHash: string;
} {
  return typeof value.requestId === 'string'
    && REQUEST_ID.test(value.requestId)
    && safeString(value.projectPath, 4_096)
    && safeString(value.relativePath, 4_096)
    && typeof value.contentHash === 'string'
    && CONTENT_HASH.test(value.contentHash);
}

function validateProgress(value: unknown): AnalysisProgress | null {
  if (!isRecord(value) || typeof value.phase !== 'string' || !PROGRESS_PHASES.has(value.phase)) return null;
  if (!validCount(value.processedFiles) || !validCount(value.totalFiles)) return null;
  if (!validCount(value.percentage) || value.percentage > 100 || value.processedFiles > value.totalFiles && value.totalFiles > 0) return null;
  return {
    phase: value.phase as AnalysisProgress['phase'],
    processedFiles: value.processedFiles,
    totalFiles: value.totalFiles,
    percentage: value.percentage,
  };
}

function isProjectAnalysis(value: unknown): value is ProjectAnalysis {
  if (!isRecord(value) || !isRecord(value.summary)) return false;
  return safeString(value.summary.name, 1_000)
    && safeString(value.summary.rootPath, 4_096)
    && Array.isArray(value.nodes)
    && value.nodes.length <= 100_000
    && Array.isArray(value.edges)
    && value.edges.length <= 200_000
    && Array.isArray(value.diagnostics)
    && value.diagnostics.length <= 100_000
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => safeString(warning, 10_000));
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

function safeString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
