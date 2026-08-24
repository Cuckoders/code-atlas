import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/server/app.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('API', () => {
  it('returns a demo graph', async () => {
    app = await createApp({ logger: false, demoPath: fixturePath });
    const response = await app.inject({ method: 'GET', url: '/api/demo' });
    expect(response.statusCode).toBe(200);
    expect(response.json().nodes.length).toBeGreaterThan(5);
  });

  it('validates analyze input', async () => {
    app = await createApp({ logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { path: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});
