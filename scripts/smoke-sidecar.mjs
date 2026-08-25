import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sidecarFileName } from './desktop-platform.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(repositoryRoot, 'dist-sidecar');
const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, 'build-manifest.json'), 'utf8'));
const binaryPath = path.join(
  repositoryRoot,
  'src-tauri',
  'binaries',
  sidecarFileName(manifest.targetTriple),
);
const serverPath = path.join(outputDirectory, 'server.mjs');
const workerPath = path.join(outputDirectory, 'analysis-worker.mjs');
const wasmDirectory = path.join(outputDirectory, 'wasm');
const demoPath = path.join(outputDirectory, 'demo');
const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), 'code-atlas-sidecar-'));
const port = await reserveEphemeralPort();
const token = randomBytes(32).toString('hex');
const origin = `http://127.0.0.1:${port}`;
let diagnostics = '';

const child = spawn(binaryPath, [serverPath], {
  cwd: temporaryDirectory,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    PORT: String(port),
    CODE_ATLAS_DESKTOP_SIDECAR: '1',
    CODE_ATLAS_API_TOKEN: token,
    CODE_ATLAS_DATABASE: path.join(temporaryDirectory, 'code-atlas.sqlite'),
    CODE_ATLAS_WORKER_PATH: workerPath,
    CODE_ATLAS_WASM_DIR: wasmDirectory,
    CODE_ATLAS_DEMO_PATH: demoPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });
child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });

try {
  await waitForHealth();
  const unauthorized = await fetch(`${origin}/api/health`);
  if (unauthorized.status !== 401) throw new Error(`Expected unauthenticated health check to return 401, got ${unauthorized.status}`);

  const createResponse = await request('/api/analysis-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: demoPath }),
  });
  if (createResponse.status !== 202) throw new Error(`Could not enqueue sidecar analysis (${createResponse.status})`);
  let job = await createResponse.json();
  for (let attempt = 0; attempt < 300 && ['queued', 'running'].includes(job.status); attempt += 1) {
    await delay(50);
    const response = await request(`/api/analysis-jobs/${job.id}`);
    job = await response.json();
  }
  if (job.status !== 'completed' || !job.snapshotId) throw new Error(`Sidecar analysis did not complete: ${JSON.stringify(job)}`);

  const snapshotResponse = await request(`/api/snapshots/${job.snapshotId}`);
  const snapshot = await snapshotResponse.json();
  if (!snapshot.analysis?.summary?.execution?.isolated) throw new Error('Sidecar analysis did not use an isolated worker thread.');
  if (snapshot.analysis.summary.filesScanned < 5) throw new Error('Sidecar analysis returned an incomplete demo graph.');

  console.log(JSON.stringify({
    status: 'ok',
    targetTriple: manifest.targetTriple,
    filesScanned: snapshot.analysis.summary.filesScanned,
    nodes: snapshot.analysis.nodes.length,
    workerThreadId: snapshot.analysis.summary.execution.workerThreadId,
  }));
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

async function request(apiPath, init) {
  const headers = new Headers(init?.headers);
  headers.set('x-code-atlas-token', token);
  return fetch(`${origin}${apiPath}`, { ...init, headers });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Sidecar exited before becoming ready (${child.exitCode}).`);
    try {
      const response = await request('/api/health');
      if (response.ok) return;
    } catch {
      // The sidecar may still be binding the socket.
    }
    await delay(100);
  }
  throw new Error('Sidecar health check timed out.');
}

async function reserveEphemeralPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port.');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
