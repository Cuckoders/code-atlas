import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AnalysisWorkerCancelledError,
  runAnalysisWorker,
} from '../src/server/analysis-worker-runner.js';
import { SnapshotStore } from '../src/server/snapshot-store.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');

describe('runAnalysisWorker', () => {
  it('terminates an active worker when the abort signal fires', async () => {
    const snapshots = new SnapshotStore(':memory:');
    const controller = new AbortController();
    try {
      const analysis = runAnalysisWorker(fixturePath, undefined, snapshots, () => undefined, controller.signal);
      controller.abort();
      await expect(analysis).rejects.toBeInstanceOf(AnalysisWorkerCancelledError);
    } finally {
      snapshots.close();
    }
  });
});
