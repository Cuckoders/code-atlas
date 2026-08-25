import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/server/analyzer.js';
import { isSafeGitReference } from '../src/server/git-analyzer.js';

const execFileAsync = promisify(execFile);

describe('Git project analysis', () => {
  it('collects history, marks hotspots and compares with a reference', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-git-'));
    try {
      await git(temporaryRoot, ['init', '-b', 'main']);
      await git(temporaryRoot, ['config', 'user.name', 'Atlas Tester']);
      await git(temporaryRoot, ['config', 'user.email', 'atlas@example.test']);
      await fs.writeFile(path.join(temporaryRoot, 'package.json'), '{"name":"git-fixture"}');
      await fs.writeFile(path.join(temporaryRoot, 'legacy.ts'), 'export class LegacyService {}');
      await fs.writeFile(path.join(temporaryRoot, 'service.ts'), `
        export class OrderService {
          run(input: string): boolean { return Boolean(input); }
          health(): boolean { return false; }
        }
      `);
      await fs.writeFile(path.join(temporaryRoot, 'engine.ts'), `${sourceWithLines(205, 'first')}\nimport { LegacyService } from './legacy';\nexport const legacy = new LegacyService();`);
      await commitAll(temporaryRoot, 'initial');
      await git(temporaryRoot, ['branch', 'baseline']);

      await fs.rm(path.join(temporaryRoot, 'legacy.ts'));
      await fs.writeFile(path.join(temporaryRoot, 'service.ts'), `
        export class OrderService {
          run(input: number): Promise<boolean> { return Promise.resolve(input > 0); }
          health(): boolean { return true; }
          stop(reason?: string): void {}
        }
      `);
      await fs.writeFile(path.join(temporaryRoot, 'engine.ts'), sourceWithLines(206, 'second'));
      await commitAll(temporaryRoot, 'second');
      await fs.writeFile(path.join(temporaryRoot, 'engine.ts'), sourceWithLines(207, 'third'));
      await commitAll(temporaryRoot, 'third');

      const result = await analyzeProject(temporaryRoot, { compareRef: 'baseline' });
      const module = result.nodes.find((node) => node.path === 'engine.ts' && node.id.startsWith('module:'));

      expect(result.summary.git).toEqual(expect.objectContaining({
        available: true,
        branch: 'main',
        commitsAnalyzed: 3,
        contributors: ['Atlas Tester'],
        comparison: expect.objectContaining({
          baseRef: 'baseline',
          modified: 2,
          deleted: 1,
          architecture: expect.objectContaining({ nodesModified: 3, nodesRemoved: 2 }),
        }),
      }));
      expect(module?.metadata).toEqual(expect.objectContaining({
        gitCommits: 3,
        gitChange: 'modified',
      }));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'change-hotspot' }),
      ]));
      expect(result.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'legacy.ts', metadata: expect.objectContaining({ diffStatus: 'removed' }) }),
        expect.objectContaining({ label: 'LegacyService', metadata: expect.objectContaining({ diffStatus: 'removed' }) }),
      ]));
      expect(result.nodes.find((node) => node.label === 'OrderService')?.structureDiff).toEqual(expect.objectContaining({
        added: [expect.objectContaining({ name: 'stop' })],
        changed: expect.arrayContaining([
          expect.objectContaining({
            name: 'run',
            before: expect.objectContaining({ signature: 'run(input: string): boolean' }),
            after: expect.objectContaining({ signature: 'run(input: number): Promise<boolean>' }),
          }),
          expect.objectContaining({
            name: 'health',
            before: expect.objectContaining({ signature: 'health(): boolean' }),
            after: expect.objectContaining({ signature: 'health(): boolean' }),
            sourceDiff: expect.arrayContaining([
              expect.objectContaining({ kind: 'removed', content: expect.stringContaining('return false') }),
              expect.objectContaining({ kind: 'added', content: expect.stringContaining('return true') }),
            ]),
          }),
        ]),
      }));
      expect(result.edges.some((edge) => edge.change === 'removed')).toBe(true);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects option-like and revision-expression references', () => {
    expect(isSafeGitReference('--output=/tmp/file')).toBe(false);
    expect(isSafeGitReference('main..feature')).toBe(false);
    expect(isSafeGitReference('main@{1}')).toBe(false);
    expect(isSafeGitReference('release/v1.2')).toBe(true);
  });
});

async function git(directory: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: directory, timeout: 5_000 });
}

async function commitAll(directory: string, message: string): Promise<void> {
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', message]);
}

function sourceWithLines(lines: number, value: string): string {
  return [
    `export const version = '${value}';`,
    ...Array.from({ length: lines - 1 }, (_, index) => `export const value${index} = ${index};`),
  ].join('\n');
}
