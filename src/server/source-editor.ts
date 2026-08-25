import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenSourceRequest, OpenSourceResult, SourceEditor } from '../shared/source-editor.js';

export interface ResolvedSourceTarget {
  targetPath: string;
  editor: SourceEditor;
  line?: number;
  column?: number;
  directory: boolean;
}

export interface EditorLaunchCommand {
  command: string;
  args: string[];
}

export type EditorLauncher = (target: ResolvedSourceTarget) => Promise<void>;

export class SourceEditorError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'SourceEditorError';
  }
}

export async function openSourceFile(
  input: OpenSourceRequest,
  launch: EditorLauncher = launchSourceEditor,
): Promise<OpenSourceResult> {
  const target = await resolveSourceTarget(input);
  try {
    await launch(target);
  } catch (error) {
    if (error instanceof SourceEditorError) throw error;
    throw new SourceEditorError('Не удалось запустить выбранный редактор. Проверьте, что он установлен.', 422);
  }
  return { opened: true, editor: input.editor };
}

export async function resolveSourceTarget(input: OpenSourceRequest): Promise<ResolvedSourceTarget> {
  if (path.isAbsolute(input.filePath) || path.win32.isAbsolute(input.filePath) || path.posix.isAbsolute(input.filePath)) {
    throw new SourceEditorError('Путь к исходнику должен быть относительным к проекту.');
  }

  let projectRoot: string;
  try {
    projectRoot = await realpath(input.projectPath);
    if (!(await stat(projectRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SourceEditorError('Корневая папка проекта больше не существует.', 404);
  }

  let targetPath: string;
  try {
    targetPath = await realpath(path.resolve(projectRoot, input.filePath));
  } catch {
    throw new SourceEditorError('Файл или папка исходника больше не существует.', 404);
  }

  const relativeTarget = path.relative(projectRoot, targetPath);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new SourceEditorError('Исходник находится за пределами анализируемого проекта.');
  }

  const targetStats = await stat(targetPath);
  if (!targetStats.isFile() && !targetStats.isDirectory()) {
    throw new SourceEditorError('Этот тип исходника нельзя открыть в редакторе.');
  }

  return {
    targetPath,
    editor: input.editor,
    ...(targetStats.isFile() && input.line ? { line: input.line, column: input.column ?? 1 } : {}),
    directory: targetStats.isDirectory(),
  };
}

export function editorLaunchCommand(
  target: ResolvedSourceTarget,
  platform: NodeJS.Platform = process.platform,
): EditorLaunchCommand {
  if (target.editor === 'vscode' || target.editor === 'cursor') {
    const protocol = target.editor === 'vscode' ? 'vscode' : 'cursor';
    const normalizedPath = encodeURI(target.targetPath.replaceAll('\\', '/'))
      .replaceAll('#', '%23')
      .replaceAll('?', '%3F');
    const location = target.line ? `:${target.line}:${target.column ?? 1}` : '';
    return platformOpenCommand(`${protocol}://file/${normalizedPath}${location}`, platform, true);
  }

  if (target.editor === 'simple') {
    if (target.directory) return platformOpenCommand(target.targetPath, platform, false);
    if (platform === 'win32') return { command: 'notepad.exe', args: [target.targetPath] };
    if (platform === 'darwin') return { command: 'open', args: ['-a', 'TextEdit', target.targetPath] };
  }

  return platformOpenCommand(target.targetPath, platform, false);
}

export async function launchSourceEditor(target: ResolvedSourceTarget): Promise<void> {
  const launch = editorLaunchCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function platformOpenCommand(target: string, platform: NodeJS.Platform, uri: boolean): EditorLaunchCommand {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') {
    return uri
      ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] }
      : { command: 'explorer.exe', args: [target] };
  }
  return { command: 'xdg-open', args: [uri ? target : pathToFileURL(target).href] };
}
