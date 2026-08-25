import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  editorLaunchCommand,
  openSourceFile,
  SourceEditorError,
  type ResolvedSourceTarget,
} from '../src/server/source-editor.js';

let temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories = [];
});

describe('source editor launcher', () => {
  it('resolves a source inside the project and preserves its line', async () => {
    const project = await temporaryDirectory();
    await writeFile(path.join(project, 'app.ts'), 'export const value = 1;\n');
    let launched: ResolvedSourceTarget | null = null;

    const result = await openSourceFile({
      projectPath: project,
      filePath: 'app.ts',
      editor: 'vscode',
      line: 12,
      column: 3,
    }, async (target) => { launched = target; });

    expect(result).toEqual({ opened: true, editor: 'vscode' });
    expect(launched).toEqual({
      targetPath: path.join(await realpath(project), 'app.ts'),
      editor: 'vscode',
      line: 12,
      column: 3,
      directory: false,
    });
  });

  it('rejects traversal and symlinks outside the project', async () => {
    const project = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, 'secret.ts'), 'secret\n');
    await symlink(path.join(outside, 'secret.ts'), path.join(project, 'linked.ts'));
    const launch = async () => { throw new Error('must not launch'); };

    await expect(openSourceFile({ projectPath: project, filePath: '../secret.ts', editor: 'system' }, launch))
      .rejects.toBeInstanceOf(SourceEditorError);
    await expect(openSourceFile({ projectPath: project, filePath: 'linked.ts', editor: 'system' }, launch))
      .rejects.toThrow('за пределами');
  });

  it('builds allowlisted platform commands without a shell', () => {
    const target: ResolvedSourceTarget = {
      targetPath: 'C:\\work & notes\\app.ts',
      editor: 'vscode',
      line: 8,
      column: 2,
      directory: false,
    };

    expect(editorLaunchCommand(target, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'vscode://file/C:/work%20&%20notes/app.ts:8:2'],
    });
    expect(editorLaunchCommand({ ...target, editor: 'simple' }, 'win32')).toEqual({
      command: 'notepad.exe',
      args: [target.targetPath],
    });
    expect(editorLaunchCommand({ ...target, editor: 'simple', directory: true }, 'win32')).toEqual({
      command: 'explorer.exe',
      args: [target.targetPath],
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-atlas-editor-'));
  temporaryDirectories.push(directory);
  return directory;
}
