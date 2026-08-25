import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/server/app.js';
import type { AnalysisJob, AnalysisSnapshotSummary, StoredAnalysisSnapshot } from '../src/shared/graph.js';

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

  it('rejects unsafe Git references', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { path: fixturePath, compareRef: '--output=/tmp/atlas' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('runs analysis in the background and persists the completed snapshot', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/analysis-jobs',
      payload: { path: fixturePath },
    });
    expect(createResponse.statusCode).toBe(202);

    const completed = await waitForJob(app, createResponse.json<AnalysisJob>().id);
    expect(completed).toEqual(expect.objectContaining({ status: 'completed', snapshotId: expect.any(String) }));

    const listResponse = await app.inject({ method: 'GET', url: '/api/snapshots' });
    expect(listResponse.statusCode).toBe(200);
    const snapshots = listResponse.json<AnalysisSnapshotSummary[]>();
    expect(snapshots).toEqual([
      expect.objectContaining({ id: completed.snapshotId, projectName: 'sample-commerce', nodeCount: expect.any(Number) }),
    ]);

    const snapshotResponse = await app.inject({ method: 'GET', url: `/api/snapshots/${completed.snapshotId}` });
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.json<StoredAnalysisSnapshot>()).toEqual(expect.objectContaining({
      snapshot: expect.objectContaining({ id: completed.snapshotId }),
      analysis: expect.objectContaining({ nodes: expect.any(Array), edges: expect.any(Array) }),
    }));
  });

  it('validates job identifiers before looking them up', async () => {
    app = await createApp({ logger: false, databasePath: ':memory:' });
    const malformed = await app.inject({ method: 'GET', url: '/api/analysis-jobs/not-an-id' });
    const missing = await app.inject({ method: 'GET', url: '/api/analysis-jobs/123e4567-e89b-42d3-a456-426614174000' });
    expect(malformed.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Задание анализа не найдено.' });
  });
});

async function waitForJob(instance: FastifyInstance, id: string): Promise<AnalysisJob> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await instance.inject({ method: 'GET', url: `/api/analysis-jobs/${id}` });
    const job = response.json<AnalysisJob>();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Background analysis did not finish in time');
}
