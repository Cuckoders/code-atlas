import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(repositoryRoot, 'dist-sidecar');
const binariesDirectory = path.join(repositoryRoot, 'src-tauri', 'binaries');
const wasmDirectory = path.join(outputDirectory, 'wasm');

assertInsideRepository(outputDirectory);
assertInsideRepository(binariesDirectory);
await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(wasmDirectory, { recursive: true });
await fs.mkdir(binariesDirectory, { recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: {
    server: 'src/server/index.ts',
    'analysis-worker': 'src/server/analysis-worker.ts',
  },
  bundle: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __pathDirname } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);",
  },
  entryNames: '[name]',
  format: 'esm',
  legalComments: 'none',
  outdir: outputDirectory,
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  target: 'node22.5',
});

const wasmAssets = new Map([
  ['web-tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm'],
  ['tree-sitter-java.wasm', '@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm'],
  ['tree-sitter-go.wasm', '@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm'],
  ['tree-sitter-rust.wasm', '@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm'],
  ['tree-sitter-c-sharp.wasm', '@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm'],
  ['tree-sitter-php.wasm', '@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm'],
  ['tree-sitter-kotlin.wasm', '@binclusive/tree-sitter-kotlin-wasm/tree-sitter-kotlin.wasm'],
]);
for (const [assetName, specifier] of wasmAssets) {
  await fs.copyFile(require.resolve(specifier), path.join(wasmDirectory, assetName));
}
await fs.cp(
  path.join(repositoryRoot, 'examples', 'sample-commerce'),
  path.join(outputDirectory, 'demo'),
  { recursive: true },
);

const hostTriple = readHostTriple();
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || hostTriple;
if (!/^[A-Za-z0-9_.-]+$/.test(targetTriple)) throw new Error('Invalid Tauri target triple.');
if (targetTriple !== hostTriple) {
  throw new Error(`Cannot package the ${hostTriple} Node runtime for cross-target ${targetTriple}. Run this build on the target platform.`);
}

const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const sidecarPath = path.join(binariesDirectory, `code-atlas-node-${targetTriple}${executableSuffix}`);
await fs.copyFile(process.execPath, sidecarPath, constants.COPYFILE_FICLONE);
if (process.platform !== 'win32') await fs.chmod(sidecarPath, 0o755);

const artifacts = {};
for (const filePath of await listFiles(outputDirectory)) {
  const relativePath = path.relative(outputDirectory, filePath).split(path.sep).join('/');
  artifacts[relativePath] = await describeFile(filePath);
}
artifacts[`../binaries/${path.basename(sidecarPath)}`] = await describeFile(sidecarPath);
await fs.writeFile(path.join(outputDirectory, 'build-manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  nodeVersion: process.version,
  targetTriple,
  artifacts,
}, null, 2)}\n`);

console.log(`Sidecar assets ready for ${targetTriple}: ${path.relative(repositoryRoot, sidecarPath)}`);

function readHostTriple() {
  const rustcFromRustup = path.join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc');
  const rustc = existsSync(rustcFromRustup) ? rustcFromRustup : 'rustc';
  const version = execFileSync(rustc, ['-vV'], { encoding: 'utf8' });
  const host = /^host:\s*(\S+)$/m.exec(version)?.[1];
  if (!host) throw new Error('Could not determine the Rust host target.');
  return host;
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat().sort();
}

async function describeFile(filePath) {
  const content = await fs.readFile(filePath);
  return {
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function assertInsideRepository(targetPath) {
  const relativePath = path.relative(repositoryRoot, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to modify path outside repository: ${targetPath}`);
  }
}
