import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnalysisError, analyzeProject } from '../src/server/analyzer.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');

describe('analyzeProject', () => {
  it('discovers services, languages, databases and source symbols', async () => {
    const result = await analyzeProject(fixturePath);

    expect(result.summary.services).toBe(2);
    expect(result.summary.modules).toBe(3);
    expect(result.summary.databases).toEqual(expect.arrayContaining(['PostgreSQL', 'Redis']));
    expect(result.summary.languages.map((language) => language.name)).toEqual(
      expect.arrayContaining(['TypeScript', 'Python']),
    );
    expect(result.nodes.some((node) => node.label === 'CatalogController' && node.kind === 'controller')).toBe(true);
    expect(result.nodes.some((node) => node.label === 'OrderJob' && node.members?.some((member) => member.name === 'execute'))).toBe(true);
    expect(result.edges.some((edge) => edge.kind === 'imports')).toBe(true);
  });

  it('rejects a missing directory', async () => {
    await expect(analyzeProject(path.join(fixturePath, 'missing'))).rejects.toBeInstanceOf(AnalysisError);
  });
});
