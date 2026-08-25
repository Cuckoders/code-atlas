import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnalysisError, analyzeProject } from '../src/server/analyzer.js';
import type { AnalysisProgress } from '../src/shared/graph.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');

describe('analyzeProject', () => {
  it('discovers services, languages, databases and source symbols', async () => {
    const result = await analyzeProject(fixturePath);

    expect(result.summary.services).toBe(2);
    expect(result.summary.modules).toBe(4);
    expect(result.summary.databases).toEqual(expect.arrayContaining(['PostgreSQL', 'Redis']));
    expect(result.summary.languages.map((language) => language.name)).toEqual(
      expect.arrayContaining(['TypeScript', 'Python', 'Java']),
    );
    expect(result.nodes.some((node) => node.label === 'CatalogController' && node.kind === 'controller')).toBe(true);
    expect(result.nodes.some((node) => (
      node.label === 'InventoryController'
      && node.kind === 'controller'
      && node.members?.some((member) => member.name === 'reserve')
    ))).toBe(true);
    expect(result.nodes.some((node) => node.label === 'OrderJob' && node.members?.some((member) => member.name === 'execute'))).toBe(true);
    expect(result.edges.some((edge) => edge.kind === 'imports')).toBe(true);
    const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
    expect(result.edges.some((edge) => (
      edge.kind === 'calls'
      && nodeById.get(edge.source)?.label === 'registerCatalogRoutes'
      && nodeById.get(edge.target)?.label === 'ProductRepository'
    ))).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'isolated-module')).toBe(true);
  });

  it('resolves Java namespaces and reports import cycles', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-cycle-'));
    try {
      await fs.writeFile(path.join(temporaryRoot, 'pom.xml'), '<project />');
      await fs.mkdir(path.join(temporaryRoot, 'src', 'alpha'), { recursive: true });
      await fs.mkdir(path.join(temporaryRoot, 'src', 'beta'), { recursive: true });
      await fs.writeFile(path.join(temporaryRoot, 'src', 'alpha', 'Alpha.java'), `
        package demo.alpha;
        import demo.beta.Beta;
        public class Alpha {}
      `);
      await fs.writeFile(path.join(temporaryRoot, 'src', 'beta', 'Beta.java'), `
        package demo.beta;
        import demo.alpha.Alpha;
        public class Beta {}
      `);

      const result = await analyzeProject(temporaryRoot);
      const importEdges = result.edges.filter((edge) => edge.kind === 'imports');
      expect(importEdges).toHaveLength(2);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'dependency-cycle', severity: 'error' }),
      ]));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a missing directory', async () => {
    await expect(analyzeProject(path.join(fixturePath, 'missing'))).rejects.toBeInstanceOf(AnalysisError);
  });

  it('reports bounded file-level progress through every analysis phase', async () => {
    const progress: AnalysisProgress[] = [];

    await analyzeProject(fixturePath, { onProgress: (update) => progress.push(update) });

    expect(progress[0]).toEqual({ phase: 'scanning', processedFiles: 0, totalFiles: 0, percentage: 0 });
    expect(progress).toContainEqual({ phase: 'parsing', processedFiles: 4, totalFiles: 4, percentage: 100 });
    expect(progress.at(-1)).toEqual({ phase: 'finalizing', processedFiles: 1, totalFiles: 1, percentage: 100 });
    expect(progress.every((update) => update.percentage >= 0 && update.percentage <= 100)).toBe(true);
  });
});
