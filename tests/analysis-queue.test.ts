import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnalysisQueue } from '../src/server/analysis-queue.js';
import { analyzeProject } from '../src/server/analyzer.js';
import { SnapshotStore } from '../src/server/snapshot-store.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');

describe('AnalysisQueue', () => {
  it('publishes immutable progress while an injected analyzer is running', async () => {
    const snapshots = new SnapshotStore(':memory:');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new AnalysisQueue(snapshots, async (projectPath, options) => {
      options.onProgress?.({ phase: 'parsing', processedFiles: 1, totalFiles: 4, percentage: 25 });
      await gate;
      return analyzeProject(projectPath, options);
    });

    try {
      const queued = queue.enqueue(fixturePath);
      await Promise.resolve();
      const running = queue.get(queued.id);
      expect(running).toEqual(expect.objectContaining({
        status: 'running',
        progress: { phase: 'parsing', processedFiles: 1, totalFiles: 4, percentage: 25 },
      }));

      if (running?.progress) running.progress.percentage = 99;
      expect(queue.get(queued.id)?.progress?.percentage).toBe(25);

      release();
      await queue.close();
      expect(queue.get(queued.id)).toEqual(expect.objectContaining({
        status: 'completed',
        progress: { phase: 'finalizing', processedFiles: 1, totalFiles: 1, percentage: 100 },
      }));
    } finally {
      release();
      await queue.close();
      snapshots.close();
    }
  });
});
