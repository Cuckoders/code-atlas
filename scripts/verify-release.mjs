import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argumentsSet = new Set(process.argv.slice(2));
const packageMetadata = await readJson('package.json');
const tauriConfiguration = await readJson('src-tauri/tauri.conf.json');

if (packageMetadata.version !== tauriConfiguration.version) {
  fail(`Version mismatch: package.json=${packageMetadata.version}, tauri.conf.json=${tauriConfiguration.version}.`);
}

if (!argumentsSet.has('--versions-only')) {
  const releaseTag = process.env.CODE_ATLAS_RELEASE_TAG?.trim();
  const expectedTag = `v${packageMetadata.version}`;
  if (!releaseTag) fail('CODE_ATLAS_RELEASE_TAG is required.');
  if (releaseTag !== expectedTag) {
    fail(`Release tag ${releaseTag} does not match application version ${expectedTag}.`);
  }
}

if (argumentsSet.has('--apple-signing')) {
  requireEnvironment([
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ]);
}

console.log(`Release metadata is consistent for Code Atlas ${packageMetadata.version}.`);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) fail(`Missing required release secrets: ${missing.join(', ')}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
