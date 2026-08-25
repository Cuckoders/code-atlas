import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BlueprintCodegenRequest,
  BlueprintCodegenResult,
  BlueprintScaffold,
  BlueprintScaffoldRequest,
  BlueprintProjectInspection,
} from '../shared/blueprint-codegen.js';
import type { BlueprintCodeTemplate, BlueprintEdge, BlueprintNode } from '../shared/blueprint.js';
import { validateArchitectureBlueprint } from '../shared/blueprint.js';
import { MAX_BLUEPRINT_FILE_SIZE, parseBlueprintFile, serializeBlueprintFile } from '../shared/blueprint-file.js';

const SAFE_DIRECTORY_SEGMENT = /^[A-Za-z0-9._-]{1,80}$/;

export class BlueprintCodegenError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'BlueprintCodegenError';
  }
}

export async function generateBlueprintCode(request: BlueprintCodegenRequest): Promise<BlueprintCodegenResult> {
  const validationError = validateArchitectureBlueprint(request.blueprint);
  if (validationError) throw new BlueprintCodegenError(validationError);
  if (request.blueprint.projectPath !== request.projectPath) {
    throw new BlueprintCodegenError('Blueprint относится к другому проекту.');
  }
  const segments = request.outputDirectory.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.length > 8
    || segments.some((segment) => segment === '.' || segment === '..' || !SAFE_DIRECTORY_SEGMENT.test(segment))) {
    throw new BlueprintCodegenError('Папка генерации должна быть относительным безопасным путём внутри проекта.');
  }

  let projectRoot: string;
  try {
    projectRoot = await realpath(request.projectPath);
  } catch {
    throw new BlueprintCodegenError('Корневая папка проекта больше не существует.', 404);
  }
  const outputRoot = await createContainedDirectory(projectRoot, segments);
  const scaffold = createBlueprintScaffold({ blueprintName: request.blueprintName, blueprint: request.blueprint });
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const file of scaffold.files) {
    const relativePath = path.posix.join(...segments, file.path);
    const targetPath = path.join(outputRoot, ...file.path.split('/'));
    const existed = file.overwrite && await validateOverwriteTarget(targetPath);
    try {
      await writeFile(targetPath, file.contents, { encoding: 'utf8', flag: file.overwrite ? 'w' : 'wx', mode: 0o600 });
      (existed ? updated : created).push(relativePath);
    } catch (error) {
      if (isFileExistsError(error)) skipped.push(relativePath);
      else throw error;
    }
  }

  return { outputDirectory: path.posix.join(...segments), created, updated, skipped };
}

export function createBlueprintScaffold(request: BlueprintScaffoldRequest): BlueprintScaffold {
  const validationError = validateArchitectureBlueprint(request.blueprint);
  if (validationError) throw new BlueprintCodegenError(validationError);
  const blueprintName = request.blueprintName.trim() || 'Blueprint';
  const generatedNodes = request.blueprint.nodes.filter((node) => node.codegen?.enabled !== false && isCodeNode(node));
  const edgesBySource = indexEdges(request.blueprint.edges);
  const nodeById = new Map(request.blueprint.nodes.map((node) => [node.id, node]));
  const usedNames = new Set<string>();
  const sourceFiles = generatedNodes.map((node) => {
    const extension = languageExtension(node.language);
    const configuredName = node.codegen?.fileName;
    const baseName = configuredName ? stripKnownExtension(configuredName) : slug(node.label) || `component-${node.id.slice(0, 8)}`;
    const fileName = uniqueFileName(`${baseName}${extension}`, usedNames, node.id);
    const dependencies = (edgesBySource.get(node.id) ?? [])
      .map((edge) => nodeById.get(edge.target))
      .filter((dependency): dependency is BlueprintNode => Boolean(dependency));
    return {
      path: fileName,
      contents: renderNode(node, dependencies, node.codegen?.template ?? 'auto'),
      overwrite: false,
    };
  });
  const fileList = sourceFiles.map((file) => `- \`${file.path}\``).join('\n') || '- Кодовые компоненты пока не добавлены.';
  const packageName = slug(blueprintName) || 'blueprint-project';
  return {
    folderName: packageName,
    files: [
      ...sourceFiles,
      {
        path: 'package.json',
        contents: `${JSON.stringify({
          name: packageName,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { start: 'node server.mjs' },
          engines: { node: '>=20' },
        }, null, 2)}\n`,
        overwrite: true,
      },
      {
        path: 'server.mjs',
        contents: renderRuntimeServer(blueprintName, request.blueprint),
        overwrite: true,
      },
      {
        path: 'code-atlas.blueprint.json',
        contents: serializeBlueprintFile(blueprintName, request.blueprint),
        overwrite: true,
      },
      {
        path: 'README.md',
        contents: `# ${blueprintName}\n\nПолноценный запускаемый проект, созданный в Code Atlas. Откройте эту папку через верхнюю строку Code Atlas и нажмите «Построить карту», чтобы работать с ней как с обычным проектом.\n\n## Запуск\n\n\`\`\`bash\nnpm start\n\`\`\`\n\nСервер слушает \`http://127.0.0.1:3000\`. Проверка: \`GET /health\`. Любой другой локальный HTTP-запрос запускает логику Blueprint и возвращает результат вместе с трейсом. Порт можно изменить переменной \`PORT\`.\n\n## Сгенерированные компоненты\n\n${fileList}\n\nФайл \`code-atlas.blueprint.json\` хранит редактируемый исходный план архитектуры.\n`,
        overwrite: true,
      },
    ],
  };
}

function renderRuntimeServer(blueprintName: string, blueprint: BlueprintScaffoldRequest['blueprint']): string {
  const model = JSON.stringify({
    name: blueprintName,
    nodes: blueprint.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      behavior: node.behavior ?? { kind: 'pass' },
    })),
    edges: blueprint.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.kind })),
  }).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

  return `// Generated by Code Atlas. Zero-dependency local Blueprint runtime.
import { createServer } from 'node:http';

const blueprint = ${model};
const host = '127.0.0.1';
const requestedPort = Number.parseInt(process.env.PORT ?? '3000', 10);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3000;
const maxBodyBytes = 1024 * 1024;

const server = createServer(async (request, response) => {
  setCors(response);
  if (request.method === 'OPTIONS') return send(response, 204, null);
  if (request.url === '/health') return send(response, 200, { status: 'ok', blueprint: blueprint.name });
  if (request.url === '/blueprint') return send(response, 200, blueprint);
  try {
    const input = await readInput(request);
    const result = await executeBlueprint(input);
    send(response, result.status === 'failed' ? 500 : 200, {
      ok: result.status === 'completed',
      request: { method: request.method, path: request.url },
      ...result,
    });
  } catch (error) {
    send(response, error?.statusCode ?? 500, { ok: false, error: error instanceof Error ? error.message : 'Runtime error' });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(\`CODE_ATLAS_READY http://\${host}:\${actualPort}\`);
  console.log(\`Blueprint "\${blueprint.name}" is running\`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function readInput(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function executeBlueprint(payload) {
  const nodeById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const incoming = new Set(blueprint.edges.map((edge) => edge.target));
  const outgoing = new Map();
  for (const edge of blueprint.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  const entry = blueprint.nodes.find((node) => !incoming.has(node.id)) ?? blueprint.nodes[0];
  if (!entry) return { status: 'completed', startedAt: new Date().toISOString(), steps: [], output: payload };
  const queue = [{ nodeId: entry.id, input: payload }];
  const visited = new Set();
  const steps = [];
  let output = payload;
  let failed = false;
  while (queue.length && steps.length < blueprint.nodes.length) {
    const current = queue.shift();
    if (visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    const node = nodeById.get(current.nodeId);
    if (!node) continue;
    const started = Date.now();
    try {
      output = await executeNode(node, current.input);
      steps.push({ nodeId: node.id, nodeLabel: node.label, status: 'success', durationMs: Date.now() - started, input: current.input, output, ...(current.viaEdgeId ? { viaEdgeId: current.viaEdgeId } : {}) });
      for (const edge of outgoing.get(node.id) ?? []) queue.push({ nodeId: edge.target, input: output, viaEdgeId: edge.id });
    } catch (error) {
      failed = true;
      steps.push({ nodeId: node.id, nodeLabel: node.label, status: 'failed', durationMs: Date.now() - started, input: current.input, error: error instanceof Error ? error.message : 'Component failed', ...(current.viaEdgeId ? { viaEdgeId: current.viaEdgeId } : {}) });
    }
  }
  return { status: failed ? 'failed' : 'completed', startedAt: new Date().toISOString(), entryNodeId: entry.id, steps, ...(failed ? {} : { output }) };
}

async function executeNode(node, input) {
  const behavior = node.behavior ?? { kind: 'pass' };
  if (behavior.kind === 'delay') await new Promise((resolve) => setTimeout(resolve, behavior.delayMs ?? 250));
  if (behavior.kind === 'fail') throw new Error(behavior.config?.trim() || 'Blueprint failure');
  if (behavior.kind === 'validate') {
    const fields = (behavior.config ?? '').split(',').map((field) => field.trim()).filter(Boolean);
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const missing = fields.filter((field) => !(field in record));
    if (missing.length) throw new Error(\`Missing required fields: \${missing.join(', ')}\`);
  }
  if (behavior.kind === 'transform') {
    const addition = parseConfig(behavior.config, {});
    return input && addition && typeof input === 'object' && typeof addition === 'object' && !Array.isArray(input) && !Array.isArray(addition) ? { ...input, ...addition } : addition;
  }
  if (behavior.kind === 'respond') return parseConfig(behavior.config, { ok: true });
  return input;
}

function parseConfig(value, fallback) {
  if (!value?.trim()) return fallback;
  try { return JSON.parse(value); } catch { return { value }; }
}

function setCors(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}

function send(response, status, body) {
  response.statusCode = status;
  if (body === null) return response.end();
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, null, 2));
}
`;
}

export async function inspectBlueprintProject(projectPath: string): Promise<BlueprintProjectInspection> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectPath);
  } catch {
    return { found: false };
  }
  const direct = await readBlueprintManifest(projectRoot);
  if (direct) return direct;
  const nested: BlueprintProjectInspection[] = [];
  const entries = await readdir(projectRoot, { withFileTypes: true });
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = await readBlueprintManifest(path.join(projectRoot, entry.name));
    if (candidate) nested.push(candidate);
    if (nested.length > 1) {
      throw new BlueprintCodegenError('В папке найдено несколько Blueprint-проектов. Выберите конкретную вложенную папку.');
    }
  }
  return nested[0] ?? { found: false };
}

async function readBlueprintManifest(projectRoot: string): Promise<BlueprintProjectInspection | null> {
  const manifestPath = path.join(projectRoot, 'code-atlas.blueprint.json');
  let stats;
  try {
    stats = await lstat(manifestPath);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new BlueprintCodegenError('Манифест Blueprint содержит ссылку или не является файлом.');
  }
  if (stats.size > MAX_BLUEPRINT_FILE_SIZE) {
    throw new BlueprintCodegenError('Манифест Blueprint слишком большой.');
  }
  const opened = parseBlueprintFile(await readFile(manifestPath, 'utf8'), path.basename(projectRoot));
  return { found: true, name: opened.name, blueprint: opened.blueprint };
}

async function createContainedDirectory(projectRoot: string, segments: string[]): Promise<string> {
  let current = projectRoot;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const stats = await lstat(next);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new BlueprintCodegenError('Путь генерации содержит ссылку или не является папкой.');
      }
    } catch (error) {
      if (error instanceof BlueprintCodegenError) throw error;
      if (!isNotFoundError(error)) throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = next;
  }
  const resolved = await realpath(current);
  const relative = path.relative(projectRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BlueprintCodegenError('Папка генерации находится за пределами проекта.');
  }
  return resolved;
}

function renderNode(node: BlueprintNode, dependencies: BlueprintNode[], requestedTemplate: BlueprintCodeTemplate): string {
  const language = normalizeLanguage(node.language);
  const template = requestedTemplate === 'auto' ? defaultTemplate(node) : requestedTemplate;
  if (language === 'python') return renderPython(node, dependencies, template);
  if (language === 'java') return renderJava(node, dependencies, template);
  if (language === 'kotlin') return renderKotlin(node, dependencies, template);
  return renderTypeScript(node, dependencies, template);
}

function renderTypeScript(node: BlueprintNode, dependencies: BlueprintNode[], template: BlueprintCodeTemplate): string {
  const name = identifier(node.label, 'Component');
  const dependencyNames = dependencies.map((item) => identifier(item.label, 'Dependency'));
  const header = `// Generated by Code Atlas from blueprint component: ${node.label}\n`;
  const behavior = behaviorBody(node, 'typescript');
  if (template === 'interface' || node.kind === 'interface') return `${header}export interface ${name} {\n  execute(input: unknown): Promise<unknown>;\n}\n`;
  if (template === 'http-handler' || node.kind === 'controller' || node.kind === 'gateway') {
    return `${header}export async function ${lowerFirst(name)}Handler(request: { body?: unknown }) {\n${indent(behavior, 2)}\n}\n`;
  }
  const fields = dependencyNames.map((dependency) => `private readonly ${lowerFirst(dependency)}: unknown`).join(', ');
  return `${header}export class ${name} {\n  constructor(${fields}) {}\n\n  async execute(input: unknown): Promise<unknown> {\n${indent(behavior, 4)}\n  }\n}\n`;
}

function renderPython(node: BlueprintNode, dependencies: BlueprintNode[], _template: BlueprintCodeTemplate): string {
  const name = identifier(node.label, 'Component');
  const dependenciesLiteral = dependencies.map((item) => JSON.stringify(item.label)).join(', ');
  return `# Generated by Code Atlas from blueprint component: ${node.label}\nclass ${name}:\n    dependencies = [${dependenciesLiteral}]\n\n    async def execute(self, payload):\n${indent(behaviorBody(node, 'python'), 8)}\n`;
}

function renderJava(node: BlueprintNode, dependencies: BlueprintNode[], template: BlueprintCodeTemplate): string {
  const name = identifier(node.label, 'Component');
  if (template === 'interface' || node.kind === 'interface') return `// Generated by Code Atlas\npublic interface ${name} {\n    Object execute(Object input);\n}\n`;
  const comment = dependencies.length ? `    // Dependencies: ${dependencies.map((item) => item.label).join(', ')}\n` : '';
  return `// Generated by Code Atlas from blueprint component: ${node.label}\npublic class ${name} {\n${comment}    public Object execute(Object input) {\n${indent(behaviorBody(node, 'java'), 8)}\n    }\n}\n`;
}

function renderKotlin(node: BlueprintNode, dependencies: BlueprintNode[], template: BlueprintCodeTemplate): string {
  const name = identifier(node.label, 'Component');
  if (template === 'interface' || node.kind === 'interface') return `// Generated by Code Atlas\ninterface ${name} {\n    fun execute(input: Any?): Any?\n}\n`;
  const comment = dependencies.length ? `    // Dependencies: ${dependencies.map((item) => item.label).join(', ')}\n` : '';
  return `// Generated by Code Atlas from blueprint component: ${node.label}\nclass ${name} {\n${comment}    fun execute(input: Any?): Any? {\n${indent(behaviorBody(node, 'kotlin'), 8)}\n    }\n}\n`;
}

function behaviorBody(node: BlueprintNode, language: 'typescript' | 'python' | 'java' | 'kotlin'): string {
  const behavior = node.behavior ?? { kind: 'pass' as const };
  const config = behavior.config?.trim();
  if (language === 'python') {
    if (behavior.kind === 'fail') return `raise RuntimeError(${JSON.stringify(config || 'Blueprint failure')})`;
    if (behavior.kind === 'respond') return `return ${pythonLiteral(config || '{"ok": true}')}`;
    if (behavior.kind === 'validate') return `# Required fields: ${config || 'none'}\nreturn payload`;
    if (behavior.kind === 'transform') return `# Merge template: ${config || '{}'}\nreturn payload`;
    return 'return payload';
  }
  if (language === 'java' || language === 'kotlin') {
    if (behavior.kind === 'fail') return `throw new IllegalStateException(${JSON.stringify(config || 'Blueprint failure')});`;
    return 'return input;';
  }
  if (behavior.kind === 'fail') return `throw new Error(${JSON.stringify(config || 'Blueprint failure')});`;
  if (behavior.kind === 'respond') return `return ${safeJsonExpression(config, '{ ok: true }')};`;
  if (behavior.kind === 'transform') return `return { ...(input as object), ...${safeJsonExpression(config, '{}')} };`;
  if (behavior.kind === 'validate') return `// Required fields: ${config || 'none'}\nreturn input;`;
  if (behavior.kind === 'delay') return `await new Promise((resolve) => setTimeout(resolve, ${behavior.delayMs ?? 250}));\nreturn input;`;
  return 'return input;';
}

function defaultTemplate(node: BlueprintNode): BlueprintCodeTemplate {
  if (node.kind === 'controller' || node.kind === 'gateway') return 'http-handler';
  if (node.kind === 'database' || node.kind === 'cache') return 'repository';
  if (node.kind === 'queue') return 'event-handler';
  if (node.kind === 'interface') return 'interface';
  if (node.kind === 'class' || node.kind === 'abstract-class') return 'class';
  return 'service';
}

function isCodeNode(node: BlueprintNode): boolean {
  return !['system', 'database', 'cache', 'queue', 'external'].includes(node.kind) || Boolean(node.codegen?.enabled);
}

function indexEdges(edges: BlueprintEdge[]): Map<string, BlueprintEdge[]> {
  const result = new Map<string, BlueprintEdge[]>();
  for (const edge of edges) result.set(edge.source, [...(result.get(edge.source) ?? []), edge]);
  return result;
}

function languageExtension(language?: string): string {
  const normalized = normalizeLanguage(language);
  if (normalized === 'python') return '.py';
  if (normalized === 'java') return '.java';
  if (normalized === 'kotlin') return '.kt';
  return '.ts';
}

function normalizeLanguage(language?: string): 'typescript' | 'python' | 'java' | 'kotlin' {
  if (/python/i.test(language ?? '')) return 'python';
  if (/kotlin/i.test(language ?? '')) return 'kotlin';
  if (/java/i.test(language ?? '')) return 'java';
  return 'typescript';
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 72);
}

function identifier(value: string, fallback: string): string {
  const words = value.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const result = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('') || fallback;
  return /^[A-Za-z_$]/.test(result) ? result : `Component${result}`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function stripKnownExtension(value: string): string {
  return value.replace(/\.(?:ts|js|py|java|kt)$/i, '');
}

function uniqueFileName(fileName: string, used: Set<string>, id: string): string {
  if (!used.has(fileName.toLowerCase())) {
    used.add(fileName.toLowerCase());
    return fileName;
  }
  const extension = path.extname(fileName);
  const unique = `${fileName.slice(0, -extension.length)}-${id.slice(0, 8)}${extension}`;
  used.add(unique.toLowerCase());
  return unique;
}

function indent(value: string, spaces: number): string {
  const padding = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${padding}${line}`).join('\n');
}

function safeJsonExpression(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    return JSON.stringify(JSON.parse(value) as unknown);
  } catch {
    return JSON.stringify({ value });
  }
}

function pythonLiteral(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown).replaceAll('true', 'True').replaceAll('false', 'False').replaceAll('null', 'None');
  } catch {
    return JSON.stringify({ value });
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function validateOverwriteTarget(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new BlueprintCodegenError('Служебный файл Blueprint содержит ссылку или не является файлом.');
    }
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}
