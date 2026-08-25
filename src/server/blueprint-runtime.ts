import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type { BlueprintRuntimeStatus } from '../shared/blueprint-codegen.js';
import { parseBlueprintFile } from '../shared/blueprint-file.js';
import { createBlueprintScaffold } from './blueprint-codegen.js';

interface RunningProject {
  child: ChildProcess;
  origin: string;
  projectPath: string;
}

export interface BlueprintRuntimeCollector {
  endpoint: string;
  token: string;
}

export class BlueprintRuntimeError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'BlueprintRuntimeError';
  }
}

export class BlueprintRuntimeManager {
  private readonly running = new Map<string, RunningProject>();

  async start(selectedPath: string, collector?: BlueprintRuntimeCollector): Promise<BlueprintRuntimeStatus> {
    const projectPath = await resolveRuntimeProject(selectedPath);
    await ensureRuntimeFiles(projectPath);
    const existing = this.running.get(projectPath);
    if (existing && existing.child.exitCode === null) return statusFor(existing);
    if (existing) this.running.delete(projectPath);

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--experimental-transform-types', 'server.mjs'], {
      cwd: projectPath,
      env: {
        ...process.env,
        PORT: String(port),
        ...(collector ? {
          CODE_ATLAS_OTLP_ENDPOINT: collector.endpoint,
          CODE_ATLAS_OTLP_TOKEN: collector.token,
        } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const project = { child, origin, projectPath };
    this.running.set(projectPath, project);
    child.once('exit', () => {
      if (this.running.get(projectPath)?.child === child) this.running.delete(projectPath);
    });

    try {
      await waitUntilReady(child, origin);
      return statusFor(project);
    } catch (error) {
      this.running.delete(projectPath);
      child.kill('SIGTERM');
      throw error;
    }
  }

  async stop(selectedPath: string): Promise<BlueprintRuntimeStatus> {
    const projectPath = await resolveRuntimeProject(selectedPath);
    const project = this.running.get(projectPath);
    if (!project) return { status: 'stopped', projectPath };
    this.running.delete(projectPath);
    await terminate(project.child);
    return { status: 'stopped', projectPath };
  }

  async status(selectedPath: string): Promise<BlueprintRuntimeStatus> {
    const projectPath = await resolveRuntimeProject(selectedPath);
    const project = this.running.get(projectPath);
    return project && project.child.exitCode === null ? statusFor(project) : { status: 'stopped', projectPath };
  }

  async close(): Promise<void> {
    const projects = [...this.running.values()];
    this.running.clear();
    await Promise.all(projects.map((project) => terminate(project.child)));
  }
}

async function resolveRuntimeProject(selectedPath: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(selectedPath);
  } catch {
    throw new BlueprintRuntimeError('Папка проекта недоступна.', 404);
  }
  if (await isBlueprintFolder(root)) return root;
  const candidates: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 200)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    if (await isBlueprintFolder(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new BlueprintRuntimeError('Найдено несколько запускаемых Blueprint-проектов. Выберите конкретную папку.');
  throw new BlueprintRuntimeError('В папке нет Blueprint-проекта.', 404);
}

async function isBlueprintFolder(folder: string): Promise<boolean> {
  return await isRegularFile(path.join(folder, 'code-atlas.blueprint.json'));
}

async function ensureRuntimeFiles(projectPath: string): Promise<void> {
  const manifestPath = path.join(projectPath, 'code-atlas.blueprint.json');
  let opened;
  try {
    opened = parseBlueprintFile(await readFile(manifestPath, 'utf8'), path.basename(projectPath));
  } catch (error) {
    throw new BlueprintRuntimeError(error instanceof Error ? error.message : 'Манифест Blueprint повреждён.');
  }
  const scaffold = createBlueprintScaffold({ blueprintName: opened.name, blueprint: opened.blueprint });
  for (const name of ['package.json', 'server.mjs'] as const) {
    const targetPath = path.join(projectPath, name);
    const existingIsRegular = await isRegularFile(targetPath);
    if (existingIsRegular && name === 'package.json') continue;
    try {
      const file = scaffold.files.find((item) => item.path === name);
      if (!file) throw new BlueprintRuntimeError(`Не удалось создать ${name}.`);
      if (existingIsRegular) {
        const existing = await readFile(targetPath, 'utf8');
        if (!existing.startsWith('// Generated by Code Atlas. Zero-dependency local Blueprint runtime.')) continue;
      }
      await writeFile(targetPath, file.contents, { encoding: 'utf8', flag: existingIsRegular ? 'w' : 'wx', mode: 0o600 });
    } catch (error) {
      if (error instanceof BlueprintRuntimeError) throw error;
      throw new BlueprintRuntimeError(`Файл ${name} уже существует, но небезопасен или недоступен.`);
    }
  }
  if (!await isRegularFile(path.join(projectPath, 'server.mjs'))) {
    throw new BlueprintRuntimeError('server.mjs не является обычным файлом.');
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('Не удалось выбрать локальный порт.')));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady(child: ChildProcess, origin: string): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new BlueprintRuntimeError(stderr.trim() || 'Blueprint-проект завершился при запуске.');
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new BlueprintRuntimeError(stderr.trim() || 'Blueprint-проект не запустился за 5 секунд.');
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 1_500)),
  ]);
}

function statusFor(project: RunningProject): BlueprintRuntimeStatus {
  return { status: 'running', projectPath: project.projectPath, origin: project.origin };
}
