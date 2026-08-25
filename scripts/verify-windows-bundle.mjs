import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformForTargetTriple, sidecarFileName } from './desktop-platform.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = path.join(repositoryRoot, 'dist-sidecar', 'build-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

if (process.platform !== 'win32') fail('Windows bundle verification must run on a Windows host.');
if (platformForTargetTriple(manifest.targetTriple) !== 'win32') {
  fail(`Sidecar manifest contains a non-Windows target: ${manifest.targetTriple}`);
}

const sidecarName = sidecarFileName(manifest.targetTriple);
const sidecarPath = path.join(repositoryRoot, 'src-tauri', 'binaries', sidecarName);
const sidecarArtifactKey = `../binaries/${sidecarName}`;
await verifyManifestArtifact(sidecarPath, manifest.artifacts?.[sidecarArtifactKey], 'sidecar');
await verifyMagic(sidecarPath, [0x4d, 0x5a], 'Windows sidecar');

const releaseDirectory = path.join(repositoryRoot, 'src-tauri', 'target', 'release');
const applicationPath = path.join(releaseDirectory, 'code-atlas.exe');
await verifyMagic(applicationPath, [0x4d, 0x5a], 'Code Atlas executable');

const msiFiles = await filesWithExtension(path.join(releaseDirectory, 'bundle', 'msi'), '.msi');
const nsisFiles = await filesWithExtension(path.join(releaseDirectory, 'bundle', 'nsis'), '.exe');
if (msiFiles.length === 0) fail('Windows build did not produce an MSI installer.');
if (nsisFiles.length === 0) fail('Windows build did not produce an NSIS installer.');

for (const filePath of msiFiles) {
  await verifyMagic(filePath, [0xd0, 0xcf, 0x11, 0xe0], 'MSI installer');
}
for (const filePath of nsisFiles) {
  await verifyMagic(filePath, [0x4d, 0x5a], 'NSIS installer');
}

console.log(JSON.stringify({
  status: 'ok',
  targetTriple: manifest.targetTriple,
  sidecar: sidecarName,
  msi: msiFiles.map((filePath) => path.basename(filePath)),
  nsis: nsisFiles.map((filePath) => path.basename(filePath)),
}));

async function verifyManifestArtifact(filePath, expected, label) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    fail(`Build manifest does not describe the Windows ${label}.`);
  }
  const content = await readRequiredFile(filePath, label);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (content.byteLength !== expected.bytes || sha256 !== expected.sha256) {
    fail(`Windows ${label} does not match dist-sidecar/build-manifest.json.`);
  }
}

async function verifyMagic(filePath, expected, label) {
  const content = await readRequiredFile(filePath, label);
  if (content.byteLength < expected.length
    || expected.some((value, index) => content[index] !== value)) {
    fail(`${label} has an unexpected file signature: ${path.basename(filePath)}.`);
  }
}

async function readRequiredFile(filePath, label) {
  try {
    const content = await fs.readFile(filePath);
    if (content.byteLength === 0) fail(`${label} is empty: ${filePath}.`);
    return content;
  } catch (error) {
    fail(`${label} is missing: ${filePath} (${error instanceof Error ? error.message : String(error)}).`);
  }
}

async function filesWithExtension(directory, extension) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(`Bundle directory is missing: ${directory} (${error instanceof Error ? error.message : String(error)}).`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function fail(message) {
  throw new Error(message);
}
