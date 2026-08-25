import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { executeRequestProbe, RequestProbeValidationError } from '../src/server/request-probe.js';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe('request probe', () => {
  it('executes a loopback request and returns a bounded safe response', async () => {
    const origin = await startServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-request-id', 'req-test');
      response.setHeader('set-cookie', 'session=secret');
      response.end(JSON.stringify({ method: request.method, path: request.url }));
    });

    const result = await executeRequestProbe({ method: 'GET', url: `${origin}/products?id=1` });

    expect(result).toEqual(expect.objectContaining({
      method: 'GET',
      ok: true,
      status: 200,
      responseHeaders: {
        'content-type': 'application/json',
        'x-request-id': 'req-test',
      },
      responseTruncated: false,
    }));
    expect(result.responseBody).toBe('{"method":"GET","path":"/products?id=1"}');
    expect(result.responseHeaders).not.toHaveProperty('set-cookie');
  });

  it('does not follow redirects outside loopback', async () => {
    const origin = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', 'https://example.com/private');
      response.end('redirect');
    });

    const result = await executeRequestProbe({ method: 'GET', url: `${origin}/redirect` });

    expect(result.status).toBe(302);
    expect(result.url).toBe(`${origin}/redirect`);
  });

  it('truncates oversized response previews', async () => {
    const origin = await startServer((_request, response) => response.end('x'.repeat(70 * 1024)));

    const result = await executeRequestProbe({ method: 'GET', url: `${origin}/large` });

    expect(Buffer.byteLength(result.responseBody)).toBe(64 * 1024);
    expect(result.responseTruncated).toBe(true);
  });

  it('rejects remote targets, URL credentials and unsafe transport headers', async () => {
    await expect(executeRequestProbe({ method: 'GET', url: 'https://example.com' }))
      .rejects.toBeInstanceOf(RequestProbeValidationError);
    await expect(executeRequestProbe({ method: 'GET', url: 'http://user:secret@127.0.0.1:3000' }))
      .rejects.toBeInstanceOf(RequestProbeValidationError);
    await expect(executeRequestProbe({ method: 'GET', url: 'http://127.0.0.1:3000', headers: { Host: 'example.com' } }))
      .rejects.toThrow('Заголовок Host запрещён');
  });
});

async function startServer(handler: Parameters<typeof createServer>[0]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}
