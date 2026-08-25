import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/server/app.js';
import type { AnalysisJob, AnalysisSnapshotSummary, StoredAnalysisSnapshot } from '../src/shared/graph.js';
import type { RequestProbeResult } from '../src/shared/request-trace.js';
import type { ArchitectureBlueprint, BlueprintDocument, BlueprintDocumentSummary } from '../src/shared/blueprint.js';
import { createDemoOtlpPayload } from '../src/server/runtime-trace.js';
import type { RuntimeTraceSession, RuntimeTraceSummary } from '../src/shared/runtime-trace.js';
import type { ResolvedSourceTarget } from '../src/server/source-editor.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('API', () => {
  it('returns a demo graph', async () => {
    app = await createApp({ logger: false, demoPath: fixturePath, databasePath: ':memory:' });
    const response = await app.inject({ method: 'GET', url: '/api/demo' });
    expect(response.statusCode).toBe(200);
    expect(response.json().nodes.length).toBeGreaterThan(5);
  });

  it('validates analyze input', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { path: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('opens only allowlisted source paths inside the analyzed project', async () => {
    let launched: ResolvedSourceTarget | null = null;
    app = await createApp({
      logger: false,
      databasePath: ':memory:',
      launchEditor: async (target) => { launched = target; },
    });

    const opened = await app.inject({
      method: 'POST',
      url: '/api/source/open',
      payload: {
        projectPath: fixturePath,
        filePath: 'services/api/src/models.ts',
        editor: 'vscode',
        line: 7,
      },
    });
    const escaped = await app.inject({
      method: 'POST',
      url: '/api/source/open',
      payload: { projectPath: fixturePath, filePath: '../../package.json', editor: 'system' },
    });
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/source/open',
      payload: { projectPath: fixturePath, filePath: 'package.json', editor: 'shell' },
    });

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ opened: true, editor: 'vscode' });
    expect(launched).toEqual(expect.objectContaining({
      targetPath: path.join(fixturePath, 'services/api/src/models.ts'),
      line: 7,
      editor: 'vscode',
    }));
    expect(escaped.statusCode).toBe(400);
    expect(unsupported.statusCode).toBe(400);
  });

  it('protects a desktop sidecar session with an in-memory token', async () => {
    const token = 'a'.repeat(64);
    app = await createApp({ logger: false, databasePath: ':memory:', apiToken: token });

    const missing = await app.inject({ method: 'GET', url: '/api/health' });
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-code-atlas-token': 'b'.repeat(64) },
    });
    const valid = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-code-atlas-token': token },
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ status: 'ok' });
  });

  it('allows only the desktop token header in Tauri CORS preflight', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:', apiToken: 'a'.repeat(64) });
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: 'tauri://localhost',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-code-atlas-token',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('tauri://localhost');
    expect(response.headers['access-control-allow-headers']).toBe('content-type, x-code-atlas-token, x-code-atlas-otlp-token');
  });

  it('ingests authenticated local OTLP JSON and exposes stored sessions', async () => {
    const apiToken = 'c'.repeat(64);
    app = await createApp({ logger: false, databasePath: ':memory:', apiToken });
    const projectPath = fixturePath;
    const configResponse = await app.inject({
      method: 'GET',
      url: `/api/runtime-traces/collector?projectPath=${encodeURIComponent(projectPath)}`,
      headers: { 'x-code-atlas-token': apiToken },
    });
    const config = configResponse.json<{ endpoint: string; token: string }>();
    expect(config.token).toMatch(/^[0-9a-f]{64}$/);

    const unauthorized = await app.inject({
      method: 'POST',
      url: config.endpoint,
      payload: createDemoOtlpPayload(),
    });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: config.endpoint,
      headers: { 'x-code-atlas-otlp-token': config.token },
      payload: createDemoOtlpPayload(),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ partialSuccess: {} });

    const list = await app.inject({
      method: 'GET',
      url: `/api/runtime-traces?projectPath=${encodeURIComponent(projectPath)}`,
      headers: { 'x-code-atlas-token': apiToken },
    });
    const summaries = list.json<RuntimeTraceSummary[]>();
    expect(summaries).toEqual([expect.objectContaining({ status: 'error', spanCount: 4 })]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/runtime-traces/${summaries[0].id}`,
      headers: { 'x-code-atlas-token': apiToken },
    });
    expect(detail.json<RuntimeTraceSession>()).toEqual(expect.objectContaining({
      summary: expect.objectContaining({ id: summaries[0].id }),
      spans: expect.arrayContaining([expect.objectContaining({ status: 'error' })]),
    }));
  });

  it('rejects unsafe Git references', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { path: fixturePath, compareRef: '--output=/tmp/atlas' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('validates and executes a request probe through a replaceable service', async () => {
    const expected: RequestProbeResult = {
      id: 'probe-id',
      method: 'POST',
      url: 'http://127.0.0.1:3000/products',
      startedAt: new Date(0).toISOString(),
      durationMs: 8,
      ok: true,
      status: 201,
      statusText: 'Created',
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"id":"1"}',
      responseTruncated: false,
    };
    app = await createApp({
      logger: false,
      databasePath: ':memory:',
      requestProbe: async (input) => ({ ...expected, method: input.method, url: input.url }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/request-probes',
      payload: { method: 'POST', url: expected.url, body: '{"name":"demo"}' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/request-probes',
      payload: { method: 'TRACE', url: expected.url },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('rejects non-loopback request probes', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/request-probes',
      payload: { method: 'GET', url: 'https://example.com' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Request Trace разрешает запросы только к localhost/loopback.' });
  });

  it('runs analysis in the background and persists the completed snapshot', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/analysis-jobs',
      payload: { path: fixturePath },
    });
    expect(createResponse.statusCode).toBe(202);
    expect(createResponse.json<AnalysisJob>().priority).toBe('normal');

    const completed = await waitForJob(app, createResponse.json<AnalysisJob>().id);
    expect(completed).toEqual(expect.objectContaining({ status: 'completed', snapshotId: expect.any(String) }));
    expect(completed.progress).toEqual({ phase: 'finalizing', processedFiles: 1, totalFiles: 1, percentage: 100 });

    const listResponse = await app.inject({ method: 'GET', url: '/api/snapshots' });
    expect(listResponse.statusCode).toBe(200);
    const snapshots = listResponse.json<AnalysisSnapshotSummary[]>();
    expect(snapshots).toEqual([
      expect.objectContaining({ id: completed.snapshotId, projectName: 'sample-commerce', nodeCount: expect.any(Number) }),
    ]);

    const projectSnapshotsResponse = await app.inject({
      method: 'GET',
      url: `/api/snapshots?projectPath=${encodeURIComponent(fixturePath)}`,
    });
    expect(projectSnapshotsResponse.statusCode).toBe(200);
    expect(projectSnapshotsResponse.json<AnalysisSnapshotSummary[]>()).toEqual([
      expect.objectContaining({ id: completed.snapshotId, projectPath: fixturePath }),
    ]);
    expect((await app.inject({
      method: 'GET',
      url: `/api/snapshots?projectPath=${encodeURIComponent('/projects/another-project')}`,
    })).json()).toEqual([]);

    const snapshotResponse = await app.inject({ method: 'GET', url: `/api/snapshots/${completed.snapshotId}` });
    expect(snapshotResponse.statusCode).toBe(200);
    const storedSnapshot = snapshotResponse.json<StoredAnalysisSnapshot>();
    expect(storedSnapshot).toEqual(expect.objectContaining({
      snapshot: expect.objectContaining({ id: completed.snapshotId }),
      analysis: expect.objectContaining({ nodes: expect.any(Array), edges: expect.any(Array) }),
    }));
    expect(storedSnapshot.analysis.summary.execution).toEqual({
      isolated: true,
      workerThreadId: expect.any(Number),
    });

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/snapshots/${completed.snapshotId}` });
    expect(deleteResponse.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/snapshots/${completed.snapshotId}` })).statusCode).toBe(404);

    const warmResponse = await app.inject({
      method: 'POST',
      url: '/api/analysis-jobs',
      payload: { path: fixturePath },
    });
    const warmJob = await waitForJob(app, warmResponse.json<AnalysisJob>().id);
    const warmSnapshot = await app.inject({ method: 'GET', url: `/api/snapshots/${warmJob.snapshotId}` });
    expect(warmSnapshot.json<StoredAnalysisSnapshot>().analysis.summary.incremental).toEqual({
      eligibleFiles: 7,
      reusedFiles: 7,
      parsedFiles: 0,
    });

  });

  it('validates job identifiers before looking them up', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const malformed = await app.inject({ method: 'GET', url: '/api/analysis-jobs/not-an-id' });
    const missing = await app.inject({ method: 'GET', url: '/api/analysis-jobs/123e4567-e89b-42d3-a456-426614174000' });
    expect(malformed.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Задание анализа не найдено.' });
  });

  it('cancels a running analysis through the job API', async () => {
    app = await createApp({
      logger: false,
      databasePath: ':memory:',
      analysisConcurrency: 1,
      analyze: (_projectPath, options) => new Promise((_resolve, reject) => {
        options.onProgress?.({ phase: 'parsing', processedFiles: 1, totalFiles: 10, percentage: 10 });
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
    });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/analysis-jobs',
      payload: { path: fixturePath, priority: 'high' },
    });
    const jobId = createResponse.json<AnalysisJob>().id;

    const cancelResponse = await app.inject({ method: 'DELETE', url: `/api/analysis-jobs/${jobId}` });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json<AnalysisJob>()).toEqual(expect.objectContaining({
      id: jobId,
      status: 'cancelled',
      priority: 'high',
      finishedAt: expect.any(String),
    }));

    const statusResponse = await app.inject({ method: 'GET', url: `/api/analysis-jobs/${jobId}` });
    expect(statusResponse.json<AnalysisJob>().status).toBe('cancelled');
    expect((await app.inject({ method: 'GET', url: '/api/snapshots' })).json()).toEqual([]);
  });

  it('rejects unsupported analysis priorities', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/analysis-jobs',
      payload: { path: fixturePath, priority: 'critical' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Проверьте параметры запроса.' });
  });

  it('saves and loads a validated architecture blueprint', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const payload = {
      version: 1,
      projectPath: fixturePath,
      nodes: [
        {
          id: '123e4567-e89b-42d3-a456-426614174001',
          label: 'Public API',
          kind: 'service',
          status: 'approved',
          position: { x: 120, y: 80 },
          technology: 'Fastify',
        },
        {
          id: '123e4567-e89b-42d3-a456-426614174002',
          label: 'PostgreSQL',
          kind: 'database',
          status: 'planned',
          position: { x: 420, y: 80 },
        },
        {
          id: '123e4567-e89b-42d3-a456-426614174004',
          label: 'PaymentStrategy',
          kind: 'interface',
          status: 'approved',
          position: { x: 120, y: 280 },
        },
        {
          id: '123e4567-e89b-42d3-a456-426614174005',
          label: 'CardPayment',
          kind: 'class',
          status: 'planned',
          position: { x: 420, y: 280 },
        },
      ],
      edges: [
        {
          id: '123e4567-e89b-42d3-a456-426614174003',
          source: '123e4567-e89b-42d3-a456-426614174001',
          target: '123e4567-e89b-42d3-a456-426614174002',
          kind: 'writes',
        },
        {
          id: '123e4567-e89b-42d3-a456-426614174006',
          source: '123e4567-e89b-42d3-a456-426614174005',
          target: '123e4567-e89b-42d3-a456-426614174004',
          kind: 'implements',
        },
      ],
    } as const;

    const saved = await app.inject({ method: 'PUT', url: '/api/blueprints', payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ArchitectureBlueprint>()).toEqual({ ...payload, updatedAt: expect.any(String) });

    const loaded = await app.inject({
      method: 'GET',
      url: `/api/blueprints?projectPath=${encodeURIComponent(fixturePath)}`,
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json<ArchitectureBlueprint>()).toEqual(saved.json());
  });

  it('rejects blueprint connections to missing nodes', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/blueprints',
      payload: {
        version: 1,
        projectPath: fixturePath,
        nodes: [{
          id: '123e4567-e89b-42d3-a456-426614174001',
          label: 'API',
          kind: 'service',
          status: 'planned',
          position: { x: 0, y: 0 },
        }],
        edges: [{
          id: '123e4567-e89b-42d3-a456-426614174003',
          source: '123e4567-e89b-42d3-a456-426614174001',
          target: '123e4567-e89b-42d3-a456-426614174099',
          kind: 'depends',
        }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Связь должна соединять два существующих разных узла.' });
  });

  it('manages a library of named blueprint documents', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const blueprint = {
      version: 1,
      projectPath: fixturePath,
      nodes: [{
        id: '123e4567-e89b-42d3-a456-426614174001',
        label: 'Checkout API',
        kind: 'controller',
        status: 'planned',
        position: { x: 20, y: 30 },
        behavior: { kind: 'validate', config: 'orderId' },
        codegen: { enabled: true, template: 'http-handler' },
      }],
      edges: [],
    } as const;

    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/blueprints/documents',
      payload: { name: 'Checkout flow', blueprint },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<BlueprintDocument>();
    expect(created).toEqual(expect.objectContaining({ name: 'Checkout flow', nodes: blueprint.nodes }));

    const listed = await app.inject({
      method: 'GET',
      url: `/api/blueprints/documents?projectPath=${encodeURIComponent(fixturePath)}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<BlueprintDocumentSummary[]>()).toEqual([
      expect.objectContaining({ id: created.id, name: 'Checkout flow', nodeCount: 1 }),
    ]);

    const opened = await app.inject({
      method: 'GET',
      url: `/api/blueprints/documents/${created.id}?projectPath=${encodeURIComponent(fixturePath)}`,
    });
    expect(opened.json<BlueprintDocument>()).toEqual(created);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/blueprints/documents/${created.id}`,
      payload: { projectPath: fixturePath, name: 'Checkout v2' },
    });
    expect(renamed.json<BlueprintDocument>()).toEqual(expect.objectContaining({ id: created.id, name: 'Checkout v2' }));

    const duplicated = await app.inject({
      method: 'POST',
      url: `/api/blueprints/documents/${created.id}/duplicate`,
      payload: { projectPath: fixturePath, name: 'Checkout copy' },
    });
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json<BlueprintDocument>()).toEqual(expect.objectContaining({ name: 'Checkout copy' }));

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/blueprints/documents/${created.id}?projectPath=${encodeURIComponent(fixturePath)}`,
    });
    expect(removed.statusCode).toBe(204);
  });
});

async function waitForJob(instance: FastifyInstance, id: string): Promise<AnalysisJob> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await instance.inject({ method: 'GET', url: `/api/analysis-jobs/${id}` });
    const job = response.json<AnalysisJob>();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Background analysis did not finish in time');
}
