import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/server/analyzer.js';
import { SnapshotStore } from '../src/server/snapshot-store.js';

describe('SnapshotStore', () => {
  it('reopens a persisted analysis from SQLite', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-snapshots-'));
    const databasePath = path.join(temporaryRoot, 'atlas.sqlite');
    const fixturePath = path.resolve('examples/sample-commerce');
    try {
      const analysis = await analyzeProject(fixturePath);
      const firstStore = new SnapshotStore(databasePath);
      const summary = firstStore.save(analysis);
      firstStore.close();

      const reopenedStore = new SnapshotStore(databasePath);
      expect(reopenedStore.list()).toEqual([expect.objectContaining({ id: summary.id })]);
      expect(reopenedStore.get(summary.id)).toEqual(expect.objectContaining({
        snapshot: expect.objectContaining({ projectPath: analysis.summary.rootPath }),
        analysis: expect.objectContaining({ summary: analysis.summary }),
      }));
      reopenedStore.close();
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
