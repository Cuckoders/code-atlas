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
      await waitForStatus(queue, queued.id, 'completed');
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

  it('moves high-priority jobs ahead of waiting normal jobs without interrupting active work', async () => {
    const snapshots = new SnapshotStore(':memory:');
    const analysis = await analyzeProject(fixturePath);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const queue = new AnalysisQueue(snapshots, async (_projectPath, options) => {
      const label = options.compareRef ?? 'unknown';
      order.push(label);
      if (label === 'first') await firstGate;
      return analysis;
    }, undefined, 1);

    try {
      const first = queue.enqueue(fixturePath, 'first');
      const normal = queue.enqueue(fixturePath, 'normal');
      const high = queue.enqueue(fixturePath, 'high', 'high');
      expect(queue.get(first.id)?.status).toBe('running');
      expect(queue.get(normal.id)?.status).toBe('queued');
      expect(queue.get(high.id)?.status).toBe('queued');

      releaseFirst();
      await waitForStatus(queue, normal.id, 'completed');
      expect(order).toEqual(['first', 'high', 'normal']);
    } finally {
      releaseFirst();
      await queue.close();
      snapshots.close();
    }
  });

  it('runs only the configured number of analyses concurrently', async () => {
    const snapshots = new SnapshotStore(':memory:');
    const analysis = await analyzeProject(fixturePath);
    const releases = new Map<string, () => void>();
    let active = 0;
    let maximumActive = 0;
    const queue = new AnalysisQueue(snapshots, async (_projectPath, options) => {
      const label = options.compareRef ?? 'unknown';
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => { releases.set(label, resolve); });
      active -= 1;
      return analysis;
    }, undefined, 2);

    try {
      const first = queue.enqueue(fixturePath, 'one');
      const second = queue.enqueue(fixturePath, 'two');
      const third = queue.enqueue(fixturePath, 'three');
      expect(queue.get(first.id)?.status).toBe('running');
      expect(queue.get(second.id)?.status).toBe('running');
      expect(queue.get(third.id)?.status).toBe('queued');
      expect(maximumActive).toBe(2);

      releases.get('one')?.();
      await waitForRunning(queue, third.id);
      expect(maximumActive).toBe(2);

      releases.get('two')?.();
      releases.get('three')?.();
      await waitForStatus(queue, third.id, 'completed');
    } finally {
      for (const release of releases.values()) release();
      await queue.close();
      snapshots.close();
    }
  });
});

async function waitForStatus(
  queue: AnalysisQueue,
  id: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (queue.get(id)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not reach ${status}`);
}

async function waitForRunning(queue: AnalysisQueue, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (queue.get(id)?.status === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not start`);
}
