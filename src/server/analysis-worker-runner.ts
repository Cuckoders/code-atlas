import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AnalysisProgress, ProjectAnalysis } from '../shared/graph.js';
import { AnalysisError } from './analyzer.js';
import {
  isCachePathAllowed,
  validateWorkerMessage,
  type AnalysisWorkerData,
  type MainToWorkerMessage,
} from './analysis-worker-protocol.js';
import type { SnapshotStore } from './snapshot-store.js';

const MAX_ANALYSIS_DURATION_MS = 10 * 60 * 1_000;

export function runAnalysisWorker(
  projectPath: string,
  compareRef: string | undefined,
  snapshots: SnapshotStore,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<ProjectAnalysis> {
  const expectedProjectPath = path.resolve(projectPath.trim());
  const sourceMode = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(sourceMode ? './analysis-worker.ts' : './analysis-worker.js', import.meta.url);
  const worker = new Worker(workerUrl, {
    name: 'code-atlas-analyzer',
    workerData: { projectPath, ...(compareRef ? { compareRef } : {}) } satisfies AnalysisWorkerData,
    ...(sourceMode ? { execArgv: ['--import', 'tsx'] } : {}),
    resourceLimits: {
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 8,
    },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Analysis worker timed out')));
      void worker.terminate();
    }, MAX_ANALYSIS_DURATION_MS);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    worker.on('message', (value: unknown) => {
      const message = validateWorkerMessage(value);
      if (!message) {
        finish(() => reject(new Error('Analysis worker sent an invalid message')));
        void worker.terminate();
        return;
      }
      if (message.type === 'progress') {
        onProgress(message.progress);
        return;
      }
      if (message.type === 'cache-get' || message.type === 'cache-set') {
        if (!isCachePathAllowed(message.projectPath, expectedProjectPath, message.relativePath)) {
          respond(worker, { type: 'cache-response', requestId: message.requestId, ok: false });
          return;
        }
        try {
          if (message.type === 'cache-get') {
            const parsed = snapshots.getParsedSource(message.projectPath, message.relativePath, message.contentHash);
            respond(worker, { type: 'cache-response', requestId: message.requestId, ok: true, parsed });
          } else {
            snapshots.setParsedSource(message.projectPath, message.relativePath, message.contentHash, message.parsed);
            respond(worker, { type: 'cache-response', requestId: message.requestId, ok: true, parsed: null });
          }
        } catch {
          respond(worker, { type: 'cache-response', requestId: message.requestId, ok: false });
        }
        return;
      }
      if (message.type === 'result') {
        finish(() => resolve(message.analysis));
        void worker.terminate();
        return;
      }
      const error = message.operational
        ? new AnalysisError(message.message)
        : new Error(message.diagnostic ?? message.message);
      finish(() => reject(error));
      void worker.terminate();
    });

    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Analysis worker exited before completing (${code})`)));
    });
  });
}

function respond(worker: Worker, message: MainToWorkerMessage): void {
  worker.postMessage(message);
}
