import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  AtlasEdge,
  AtlasNode,
  LanguageStat,
  NodeKind,
  ProjectAnalysis,
  SymbolMember,
} from '../shared/graph.js';
import { parseWithTreeSitter, type ParsedSource } from './tree-sitter-parser.js';

const MAX_FILES = 1_500;
const MAX_FILE_SIZE = 512 * 1024;

const IGNORED_DIRECTORIES = new Set([
  '.git', '.idea', '.next', '.nuxt', '.turbo', '.venv', '.vscode',
  'build', 'coverage', 'dist', 'dist-server', 'node_modules', 'target', 'vendor',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.cs': 'C#', '.css': 'CSS',
  '.dart': 'Dart', '.go': 'Go', '.html': 'HTML', '.java': 'Java',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.php': 'PHP', '.py': 'Python', '.rb': 'Ruby', '.rs': 'Rust', '.scss': 'SCSS',
  '.swift': 'Swift', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue',
};

const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));
const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile',
]);

const DATABASE_RULES: Array<[string, RegExp]> = [
  ['PostgreSQL', /postgres(?:ql)?|\bpg\b|psycopg|npgsql/i],
  ['MySQL', /mysql|mariadb/i],
  ['MongoDB', /mongodb|mongoose|mongoengine/i],
  ['Redis', /redis|ioredis/i],
  ['SQLite', /sqlite|better-sqlite/i],
  ['Elasticsearch', /elastic(?:search)?/i],
  ['DynamoDB', /dynamodb/i],
];

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

interface ServiceInfo {
  id: string;
  name: string;
  directory: string;
  manifest: string;
  technologies: string[];
  manifestText: string;
}

export class AnalysisError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export async function analyzeProject(inputPath: string): Promise<ProjectAnalysis> {
  const startedAt = performance.now();
  const rootPath = path.resolve(inputPath.trim());
  const rootStat = await fs.stat(rootPath).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new AnalysisError('Указанный путь не существует или не является папкой.');
  }

  const { files, skipped, truncated } = await collectFiles(rootPath);
  const manifestFiles = files.filter((file) => MANIFEST_NAMES.has(path.basename(file.relativePath)));
  const services = await discoverServices(rootPath, manifestFiles);
  const projectName = path.basename(rootPath);
  const projectId = 'project:root';
  const nodes: AtlasNode[] = [{
    id: projectId,
    label: projectName,
    kind: 'project',
    path: '.',
    subtitle: 'Project root',
  }];
  const edges: AtlasEdge[] = [];
  const technologies = new Set<string>();
  const databases = new Set<string>();

  for (const service of services) {
    service.technologies.forEach((item) => technologies.add(item));
    nodes.push({
      id: service.id,
      label: service.name,
      kind: 'service',
      path: service.directory || '.',
      subtitle: path.basename(service.manifest),
      metadata: { manifest: service.manifest, technologies: service.technologies },
    });
    edges.push(edge(projectId, service.id, 'contains'));
    detectDatabases(service.manifestText).forEach((database) => databases.add(database));
  }

  const composeFiles = files.filter((file) => /(^|\/)(docker-compose|compose)[^/]*\.ya?ml$/i.test(file.relativePath));
  for (const composeFile of composeFiles) {
    const content = await readText(composeFile);
    if (content === null) continue;
    detectDatabases(content).forEach((database) => databases.add(database));
    technologies.add('Docker Compose');
  }

  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()));
  const languageCounts = new Map<string, number>();
  const moduleIds = new Map<string, string>();
  const pendingImports: Array<{ source: string; importer: string; specifier: string }> = [];
  let symbolCount = 0;

  for (const file of sourceFiles) {
    const extension = path.extname(file.relativePath).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);

    if (!isAnalyzableCode(extension) || file.size > MAX_FILE_SIZE) continue;
    const content = await readText(file);
    if (content === null) continue;

    const moduleId = `module:${file.relativePath}`;
    const owner = findOwningService(file.relativePath, services);
    moduleIds.set(normalizeModulePath(file.relativePath), moduleId);
    const parsed = await parseSource(file.relativePath, content);

    nodes.push({
      id: moduleId,
      label: path.basename(file.relativePath),
      kind: parsed.routes.length > 0 ? 'controller' : 'module',
      path: file.relativePath,
      language,
      subtitle: path.dirname(file.relativePath) === '.' ? language : path.dirname(file.relativePath),
      members: parsed.routes,
      metadata: { lines: content.split('\n').length, parser: parsed.parser },
    });
    edges.push(edge(owner?.id ?? projectId, moduleId, 'contains'));

    for (const symbol of parsed.symbols) {
      const symbolId = `symbol:${file.relativePath}:${symbol.kind}:${symbol.name}:${symbol.line}`;
      nodes.push({
        id: symbolId,
        label: symbol.name,
        kind: symbol.kind,
        path: file.relativePath,
        language,
        subtitle: `${symbol.kind} · строка ${symbol.line}`,
        members: symbol.members,
        metadata: { line: symbol.line },
      });
      edges.push(edge(moduleId, symbolId, 'contains'));
      symbolCount += 1;
    }

    parsed.imports.forEach((specifier) => pendingImports.push({
      source: moduleId,
      importer: file.relativePath,
      specifier,
    }));
  }

  for (const item of pendingImports) {
    const resolved = resolveLocalImport(item.importer, item.specifier, moduleIds);
    if (resolved && resolved !== item.source) {
      edges.push(edge(item.source, resolved, 'imports', item.specifier));
    }
  }

  for (const database of databases) {
    const databaseId = `database:${database.toLowerCase()}`;
    nodes.push({
      id: databaseId,
      label: database,
      kind: 'database',
      subtitle: 'Detected infrastructure',
    });
    for (const service of services) {
      if (detectDatabases(service.manifestText).includes(database)) {
        edges.push(edge(service.id, databaseId, 'uses'));
      }
    }
    if (!edges.some((item) => item.target === databaseId)) {
      edges.push(edge(projectId, databaseId, 'uses'));
    }
  }

  const languages = createLanguageStats(languageCounts);
  const warnings: string[] = [];
  if (truncated) warnings.push(`Достигнут лимит ${MAX_FILES} файлов. Карта построена по частичному снимку.`);
  if (sourceFiles.some((file) => file.size > MAX_FILE_SIZE)) {
    warnings.push('Некоторые крупные исходники показаны в статистике, но их символы не разбирались.');
  }

  return {
    summary: {
      name: projectName,
      rootPath,
      filesScanned: files.length,
      filesSkipped: skipped,
      services: services.length,
      modules: moduleIds.size,
      symbols: symbolCount,
      databases: [...databases].sort(),
      technologies: [...technologies].sort(),
      languages,
      durationMs: Math.round(performance.now() - startedAt),
      truncated,
    },
    nodes: deduplicateNodes(nodes),
    edges: deduplicateEdges(edges),
    warnings,
  };
}

async function collectFiles(rootPath: string): Promise<{ files: FileEntry[]; skipped: number; truncated: boolean }> {
  const files: FileEntry[] = [];
  let skipped = 0;
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.cache')) {
          skipped += 1;
          continue;
        }
        await visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat) {
        skipped += 1;
        continue;
      }
      files.push({
        absolutePath,
        relativePath: toPosix(path.relative(rootPath, absolutePath)),
        size: stat.size,
      });
    }
  }

  await visit(rootPath);
  return { files, skipped, truncated };
}

async function discoverServices(rootPath: string, manifestFiles: FileEntry[]): Promise<ServiceInfo[]> {
  const primaryManifests = manifestFiles.filter((file) => !['requirements.txt'].includes(path.basename(file.relativePath)));
  let selected = primaryManifests.length > 0 ? primaryManifests : manifestFiles;
  const hasNestedManifest = selected.some((file) => path.dirname(file.relativePath) !== '.');
  const rootPackage = selected.find((file) => file.relativePath === 'package.json');
  if (hasNestedManifest && rootPackage) {
    const rootPackageContent = (await readText(rootPackage)) ?? '';
    if (packageHasWorkspaces(rootPackageContent)) {
      selected = selected.filter((file) => file !== rootPackage);
    }
  }
  const services: ServiceInfo[] = [];
  const seenDirectories = new Set<string>();

  for (const manifestFile of selected) {
    const directory = toPosix(path.dirname(manifestFile.relativePath));
    const normalizedDirectory = directory === '.' ? '' : directory;
    if (seenDirectories.has(normalizedDirectory)) continue;
    seenDirectories.add(normalizedDirectory);
    const content = (await readText(manifestFile)) ?? '';
    const manifestName = path.basename(manifestFile.relativePath);
    const parsedName = manifestName === 'package.json' ? readPackageName(content) : null;
    const name = parsedName ?? (normalizedDirectory ? path.basename(normalizedDirectory) : path.basename(rootPath));
    services.push({
      id: `service:${normalizedDirectory || '.'}`,
      name,
      directory: normalizedDirectory,
      manifest: manifestFile.relativePath,
      technologies: detectTechnologies(manifestName, content),
      manifestText: content,
    });
  }

  if (services.length === 0) {
    services.push({
      id: 'service:.',
      name: path.basename(rootPath),
      directory: '',
      manifest: 'source tree',
      technologies: [],
      manifestText: '',
    });
  }
  return services;
}

function findOwningService(relativePath: string, services: ServiceInfo[]): ServiceInfo | undefined {
  return services
    .filter((service) => !service.directory || relativePath.startsWith(`${service.directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0];
}

function detectTechnologies(manifestName: string, content: string): string[] {
  const technologies = new Set<string>();
  const rules: Array<[string, RegExp]> = [
    ['React', /["']react["']/i], ['Next.js', /["']next["']/i],
    ['Vue', /["']vue["']/i], ['Angular', /@angular\//i],
    ['Fastify', /fastify/i], ['Express', /["']express["']/i],
    ['NestJS', /@nestjs\//i], ['Django', /django/i], ['FastAPI', /fastapi/i],
    ['Spring', /spring-boot/i], ['Rails', /rails/i], ['Flutter', /flutter/i],
  ];
  for (const [name, pattern] of rules) if (pattern.test(content)) technologies.add(name);
  if (manifestName === 'go.mod') technologies.add('Go modules');
  if (manifestName === 'Cargo.toml') technologies.add('Cargo');
  if (manifestName === 'pom.xml') technologies.add('Maven');
  if (manifestName.startsWith('build.gradle')) technologies.add('Gradle');
  return [...technologies];
}

function detectDatabases(content: string): string[] {
  return DATABASE_RULES.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
}

function readPackageName(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name.replace(/^@[^/]+\//, '') : null;
  } catch {
    return null;
  }
}

function packageHasWorkspaces(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) || (typeof parsed.workspaces === 'object' && parsed.workspaces !== null);
  } catch {
    return false;
  }
}

async function parseSource(relativePath: string, content: string): Promise<ParsedSource> {
  const extension = path.extname(relativePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) return parseTypeScript(relativePath, content);
  if (extension === '.py') return parsePython(content);
  const treeSitterResult = await parseWithTreeSitter(extension, content).catch(() => null);
  if (treeSitterResult) return treeSitterResult;
  return parseGeneric(content, extension);
}

function parseTypeScript(fileName: string, content: string): ParsedSource {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const symbols: ParsedSource['symbols'] = [];
  const imports: string[] = [];
  const routes: SymbolMember[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const members = statement.members.flatMap((member): SymbolMember[] => {
        if (!ts.isMethodDeclaration(member) || !member.name) return [];
        const name = member.name.getText(sourceFile);
        return [{
          name,
          kind: 'method',
          signature: `${name}(${member.parameters.map((parameter) => parameter.name.getText(sourceFile)).join(', ')})`,
          line: lineOf(sourceFile, member),
        }];
      });
      const classText = statement.getFullText(sourceFile);
      const isController = /Controller$/.test(statement.name.text) || /@Controller\b/.test(classText);
      symbols.push({
        name: statement.name.text,
        kind: isController ? 'controller' : 'class',
        line: lineOf(sourceFile, statement),
        members,
      });
    }
    if (ts.isInterfaceDeclaration(statement)) {
      symbols.push({
        name: statement.name.text,
        kind: 'interface',
        line: lineOf(sourceFile, statement),
        members: statement.members.flatMap((member): SymbolMember[] => {
          if (!member.name) return [];
          return [{ name: member.name.getText(sourceFile), kind: 'property', line: lineOf(sourceFile, member) }];
        }),
      });
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push({
        name: statement.name.text,
        kind: 'function',
        line: lineOf(sourceFile, statement),
        members: [],
      });
    }
  }

  const routePattern = /(?:app|router|fastify)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)|@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`)]+)?/gi;
  for (const match of content.matchAll(routePattern)) {
    const method = (match[1] ?? match[3] ?? 'route').toUpperCase();
    const route = match[2] ?? match[4] ?? '/';
    routes.push({ name: `${method} ${route}`, kind: 'route' });
  }
  return { symbols, imports, routes, parser: 'TypeScript compiler API' };
}

function parsePython(content: string): ParsedSource {
  const symbols: ParsedSource['symbols'] = [];
  const imports: string[] = [];
  const routes: SymbolMember[] = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(line);
    if (classMatch) {
      const classIndent = line.length - line.trimStart().length;
      const members: SymbolMember[] = [];
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex];
        if (nextLine.trim() && nextLine.length - nextLine.trimStart().length <= classIndent) break;
        const methodMatch = /^\s+def\s+([A-Za-z_]\w*)\s*\(([^)]*)/.exec(nextLine);
        if (methodMatch) members.push({
          name: methodMatch[1],
          kind: 'method',
          signature: `${methodMatch[1]}(${methodMatch[2]})`,
          line: nextIndex + 1,
        });
      }
      symbols.push({
        name: classMatch[1],
        kind: /Controller$|ViewSet$/.test(classMatch[1]) ? 'controller' : 'class',
        line: index + 1,
        members,
      });
    }
    const functionMatch = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (functionMatch) symbols.push({ name: functionMatch[1], kind: 'function', line: index + 1, members: [] });
    const importMatch = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
    if (importMatch) imports.push(importMatch[1] ?? importMatch[2]);
    const routeMatch = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)/i.exec(line);
    if (routeMatch) routes.push({ name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, kind: 'route', line: index + 1 });
  });
  return { symbols, imports, routes, parser: 'Python structural parser' };
}

function parseGeneric(content: string, extension: string): ParsedSource {
  const symbols: ParsedSource['symbols'] = [];
  const classPattern = /\b(class|interface|struct|trait|enum)\s+([A-Za-z_]\w*)/g;
  const functionPattern = /(?:\bfun\s+|\bfunc\s+|\bfn\s+|\bfunction\s+|\b(?:public|private|protected|static|async)\s+)*(?:[\w<>,?[\] ]+\s+)?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|=>)/g;
  for (const match of content.matchAll(classPattern)) {
    symbols.push({
      name: match[2],
      kind: match[1] === 'interface' ? 'interface' : /Controller$/.test(match[2]) ? 'controller' : 'class',
      line: lineFromOffset(content, match.index ?? 0),
      members: [],
    });
  }
  for (const match of content.matchAll(functionPattern)) {
    if (['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) continue;
    symbols.push({ name: match[1], kind: 'function', line: lineFromOffset(content, match.index ?? 0), members: [] });
  }
  const imports = extension === '.go'
    ? [...content.matchAll(/import\s+(?:\([^)]*?["`]([^"`]+)|["`]([^"`]+))/gs)].map((match) => match[1] ?? match[2])
    : [];
  return { symbols, imports, routes: [], parser: 'Structural fallback' };
}

function resolveLocalImport(importer: string, specifier: string, moduleIds: Map<string, string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalizeModulePath(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [base, `${base}/index`];
  return candidates.map((candidate) => moduleIds.get(candidate)).find(Boolean);
}

function normalizeModulePath(filePath: string): string {
  const posixPath = toPosix(filePath);
  const withoutExtension = posixPath.replace(/\.(?:tsx?|jsx?|py|java|kt|kts|go|rs|cs|php|rb|swift|dart|vue)$/, '');
  return withoutExtension.replace(/\/index$/, '');
}

function isAnalyzableCode(extension: string): boolean {
  return !['.css', '.scss', '.html'].includes(extension);
}

async function readText(file: FileEntry): Promise<string | null> {
  if (file.size > MAX_FILE_SIZE) return null;
  const buffer = await fs.readFile(file.absolutePath).catch(() => null);
  if (!buffer || buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function lineFromOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function edge(source: string, target: string, kind: AtlasEdge['kind'], label?: string): AtlasEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind, label };
}

function createLanguageStats(counts: Map<string, number>): LanguageStat[] {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts.entries()]
    .map(([name, files]) => ({ name, files, percentage: total ? Math.round((files / total) * 100) : 0 }))
    .sort((left, right) => right.files - left.files);
}

function deduplicateNodes(nodes: AtlasNode[]): AtlasNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function deduplicateEdges(edges: AtlasEdge[]): AtlasEdge[] {
  return [...new Map(edges.map((item) => [item.id, item])).values()];
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
