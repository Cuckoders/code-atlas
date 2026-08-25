import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/server/analyzer.js';
import { SnapshotStore } from '../src/server/snapshot-store.js';
import type { ArchitectureBlueprintDraft } from '../src/shared/blueprint.js';
import { createDemoOtlpPayload, parseOtlpJson } from '../src/server/runtime-trace.js';

describe('SnapshotStore', () => {
  it('stores, opens, renames, duplicates and deletes blueprint documents', () => {
    const store = new SnapshotStore(':memory:');
    try {
      const draft: ArchitectureBlueprintDraft = {
        version: 1,
        projectPath: '/projects/library-demo',
        nodes: [{
          id: '123e4567-e89b-42d3-a456-426614174001',
          label: 'Checkout',
          kind: 'service',
          status: 'planned',
          position: { x: 10, y: 20 },
          behavior: { kind: 'respond', config: '{"ok":true}' },
          codegen: { enabled: true, template: 'service' },
        }],
        edges: [],
      };

      const saved = store.saveBlueprintDocument('Checkout flow', draft);
      expect(store.listBlueprintDocuments(draft.projectPath)).toEqual([
        expect.objectContaining({ id: saved.id, name: 'Checkout flow', nodeCount: 1, edgeCount: 0 }),
      ]);
      expect(store.getBlueprintDocument(draft.projectPath, saved.id)).toEqual(saved);
      expect(store.renameBlueprintDocument(draft.projectPath, saved.id, 'Checkout v2')).toEqual(
        expect.objectContaining({ id: saved.id, name: 'Checkout v2' }),
      );

      const copy = store.duplicateBlueprintDocument(draft.projectPath, saved.id, 'Checkout copy');
      expect(copy).toEqual(expect.objectContaining({ name: 'Checkout copy', nodes: draft.nodes }));
      expect(copy?.id).not.toBe(saved.id);
      expect(store.deleteBlueprintDocument(draft.projectPath, saved.id)).toBe(true);
      expect(store.getBlueprintDocument(draft.projectPath, saved.id)).toBeNull();
      expect(store.listBlueprintDocuments(draft.projectPath)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('reopens a persisted analysis from SQLite', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-snapshots-'));
    const databasePath = path.join(temporaryRoot, 'atlas.sqlite');
    const fixturePath = path.resolve('examples/sample-commerce');
    try {
      const firstStore = new SnapshotStore(databasePath);
      const analysis = await analyzeProject(fixturePath, { parseCache: firstStore });
      expect(analysis.summary.incremental).toEqual({ eligibleFiles: 7, reusedFiles: 0, parsedFiles: 7 });
      const summary = firstStore.save(analysis);
      const blueprint: ArchitectureBlueprintDraft = {
        version: 1,
        projectPath: analysis.summary.rootPath,
        nodes: [{
          id: '123e4567-e89b-42d3-a456-426614174001',
          label: 'Checkout API',
          kind: 'service',
          status: 'planned',
          position: { x: 80, y: 120 },
        }],
        edges: [],
      };
      const savedBlueprint = firstStore.saveBlueprint(blueprint);
      const [runtimeTrace] = parseOtlpJson(createDemoOtlpPayload(), analysis.summary.rootPath);
      firstStore.saveRuntimeTraces([runtimeTrace]);
      firstStore.close();

      const reopenedStore = new SnapshotStore(databasePath);
      expect(reopenedStore.list()).toEqual([expect.objectContaining({ id: summary.id })]);
      expect(reopenedStore.get(summary.id)).toEqual(expect.objectContaining({
        snapshot: expect.objectContaining({ projectPath: analysis.summary.rootPath }),
        analysis: expect.objectContaining({ summary: analysis.summary }),
      }));
      expect(reopenedStore.getBlueprint(analysis.summary.rootPath)).toEqual(savedBlueprint);
      expect(reopenedStore.listRuntimeTraces(analysis.summary.rootPath)).toEqual([
        expect.objectContaining({ id: runtimeTrace.summary.id, spanCount: 4, status: 'error' }),
      ]);
      expect(reopenedStore.getRuntimeTrace(runtimeTrace.summary.id)).toEqual(runtimeTrace);
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
