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
      const firstStore = new SnapshotStore(databasePath);
      const analysis = await analyzeProject(fixturePath, { parseCache: firstStore });
      expect(analysis.summary.incremental).toEqual({ eligibleFiles: 7, reusedFiles: 0, parsedFiles: 7 });
      const summary = firstStore.save(analysis);
      firstStore.close();

      const reopenedStore = new SnapshotStore(databasePath);
      expect(reopenedStore.list()).toEqual([expect.objectContaining({ id: summary.id })]);
      expect(reopenedStore.get(summary.id)).toEqual(expect.objectContaining({
        snapshot: expect.objectContaining({ projectPath: analysis.summary.rootPath }),
        analysis: expect.objectContaining({ summary: analysis.summary }),
      }));
      const warmAnalysis = await analyzeProject(fixturePath, { parseCache: reopenedStore });
      expect(warmAnalysis.summary.incremental).toEqual({ eligibleFiles: 7, reusedFiles: 7, parsedFiles: 0 });
      reopenedStore.close();
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('reparses only a file whose content changed', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-incremental-'));
    const store = new SnapshotStore(':memory:');
    try {
      await fs.writeFile(path.join(temporaryRoot, 'package.json'), '{"name":"incremental-fixture"}');
      await fs.writeFile(path.join(temporaryRoot, 'alpha.ts'), 'export class Alpha { value(): number { return 1; } }');
      await fs.writeFile(path.join(temporaryRoot, 'beta.ts'), 'export class Beta { value(): number { return 1; } }');

      const cold = await analyzeProject(temporaryRoot, { parseCache: store });
      const warm = await analyzeProject(temporaryRoot, { parseCache: store });
      await fs.writeFile(path.join(temporaryRoot, 'alpha.ts'), 'export class Alpha { changed(): number { return 2; } }');
      const partial = await analyzeProject(temporaryRoot, { parseCache: store });

      expect(cold.summary.incremental).toEqual({ eligibleFiles: 2, reusedFiles: 0, parsedFiles: 2 });
      expect(warm.summary.incremental).toEqual({ eligibleFiles: 2, reusedFiles: 2, parsedFiles: 0 });
      expect(partial.summary.incremental).toEqual({ eligibleFiles: 2, reusedFiles: 1, parsedFiles: 1 });
      expect(partial.nodes.find((node) => node.label === 'Alpha')?.members).toEqual([
        expect.objectContaining({ name: 'changed' }),
      ]);
    } finally {
      store.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
