import { describe, expect, it } from 'vitest';
import type { ProjectAnalysis } from '../src/shared/graph.js';
import type { RequestProbeInput, RequestProbeResult } from '../src/shared/request-trace.js';
import { traceProjectRequest } from '../src/shared/request-trace.js';

const analysis: ProjectAnalysis = {
  summary: {
    name: 'shop', rootPath: '/shop', filesScanned: 1, filesSkipped: 0, services: 1, modules: 1,
    symbols: 3, databases: ['PostgreSQL'], technologies: [], languages: [],
    git: { available: false, commitsAnalyzed: 0, contributors: [] }, durationMs: 1, truncated: false,
  },
  nodes: [
    { id: 'project', label: 'shop', kind: 'project' },
    { id: 'service', label: 'api', kind: 'service' },
    {
      id: 'route-module', label: 'products.ts', kind: 'controller', path: 'products.ts',
      members: [
        { name: 'GET /products', kind: 'route', line: 10 },
        { name: 'GET /products/:id', kind: 'route', line: 11 },
      ],
    },
    { id: 'handler', label: 'registerProducts', kind: 'function', path: 'products.ts', metadata: { line: 9 } },
    { id: 'controller', label: 'ProductController', kind: 'controller', path: 'products.ts', metadata: { line: 2 } },
    { id: 'repository', label: 'ProductRepository', kind: 'class', path: 'models.ts' },
    { id: 'database', label: 'PostgreSQL', kind: 'database' },
    { id: 'redis', label: 'Redis', kind: 'database' },
  ],
  edges: [
    { id: 'project-service', source: 'project', target: 'service', kind: 'contains' },
    { id: 'service-module', source: 'service', target: 'route-module', kind: 'contains' },
    { id: 'module-handler', source: 'route-module', target: 'handler', kind: 'contains' },
    { id: 'module-controller', source: 'route-module', target: 'controller', kind: 'contains' },
    { id: 'handler-controller', source: 'handler', target: 'controller', kind: 'calls' },
    { id: 'handler-repository', source: 'handler', target: 'repository', kind: 'calls' },
    { id: 'service-database', source: 'service', target: 'database', kind: 'uses' },
    { id: 'service-redis', source: 'service', target: 'redis', kind: 'uses' },
  ],
  diagnostics: [
    {
      id: 'database-risk', kind: 'shared-database', severity: 'warning', title: 'Общая база данных',
      message: 'PostgreSQL shared', nodeIds: ['service', 'database'], edgeIds: ['service-database'],
    },
    {
      id: 'redis-risk', kind: 'shared-database', severity: 'warning', title: 'Общий Redis',
      message: 'Redis shared', nodeIds: ['service', 'redis'], edgeIds: ['service-redis'],
    },
  ],
  warnings: [],
};

describe('request trace inference', () => {
  it('matches parameterized routes and follows calls to dependencies', () => {
    const request = probeInput('GET', 'http://127.0.0.1:3000/products/42');
    const trace = traceProjectRequest(analysis, request, probeResult(request, 500));

    expect(trace.matchedRoute).toEqual(expect.objectContaining({ pattern: '/products/:id', nodeId: 'route-module' }));
    expect(trace.steps.map((step) => [step.role, step.nodeId])).toEqual([
      ['service', 'service'],
      ['route', 'route-module'],
      ['handler', 'handler'],
      ['controller', 'controller'],
      ['repository', 'repository'],
      ['dependency', 'database'],
      ['dependency', 'redis'],
    ]);
    expect(trace.edgeIds).toEqual(expect.arrayContaining(['service-module', 'module-handler', 'handler-controller', 'handler-repository', 'service-database', 'service-redis']));
    expect(trace.probableFailure).toEqual(expect.objectContaining({
      nodeId: 'database',
      confidence: 'medium',
      title: 'Вероятная точка HTTP 500',
    }));
  });

  it('marks the service boundary when the local process refuses a connection', () => {
    const request = probeInput('GET', 'http://127.0.0.1:3000/products');
    const response = probeResult(request);
    response.error = { kind: 'connection', message: 'Соединение отклонено.' };

    const trace = traceProjectRequest(analysis, request, response);

    expect(trace.probableFailure).toEqual(expect.objectContaining({ nodeId: 'service', confidence: 'high' }));
  });

  it('uses a concrete dependency mentioned by the error response as evidence', () => {
    const request = probeInput('GET', 'http://127.0.0.1:3000/products');
    const response = probeResult(request, 500);
    response.responseBody = '{"error":"Redis timeout"}';

    const trace = traceProjectRequest(analysis, request, response);

    expect(trace.probableFailure).toEqual(expect.objectContaining({ nodeId: 'redis', confidence: 'medium' }));
    expect(trace.probableFailure?.evidence).toContain('Ответ содержит указание на «redis».');
  });

  it('reports an unmapped endpoint without inventing graph nodes', () => {
    const request = probeInput('POST', 'http://127.0.0.1:3000/unknown');
    const trace = traceProjectRequest(analysis, request, probeResult(request, 404));

    expect(trace.steps).toEqual([]);
    expect(trace.probableFailure).toEqual(expect.objectContaining({ title: 'Маршрут не найден', confidence: 'high' }));
  });

  it('maps embedded Blueprint runtime steps to generated files and highlights the failure', () => {
    const blueprintAnalysis: ProjectAnalysis = {
      ...analysis,
      nodes: [
        { id: 'project', label: 'generated', kind: 'project' },
        { id: 'service', label: 'blueprint', kind: 'service', path: 'blueprint' },
        { id: 'web-module', label: 'web-mobile.ts', kind: 'module', path: 'blueprint/web-mobile.ts' },
        { id: 'web-class', label: 'WebMobile', kind: 'class', path: 'blueprint/web-mobile.ts' },
        { id: 'order-module', label: 'order-service.ts', kind: 'module', path: 'blueprint/order-service.ts' },
        { id: 'order-class', label: 'OrderService', kind: 'class', path: 'blueprint/order-service.ts' },
      ],
      edges: [
        { id: 'project-service', source: 'project', target: 'service', kind: 'contains' },
        { id: 'service-web', source: 'service', target: 'web-module', kind: 'contains' },
        { id: 'web-class-edge', source: 'web-module', target: 'web-class', kind: 'contains' },
        { id: 'service-order', source: 'service', target: 'order-module', kind: 'contains' },
        { id: 'order-class-edge', source: 'order-module', target: 'order-class', kind: 'contains' },
      ],
      diagnostics: [],
    };
    const request = probeInput('POST', 'http://127.0.0.1:3000/orders');
    const response = probeResult(request, 500);
    response.responseBody = JSON.stringify({
      status: 'failed',
      steps: [
        { nodeLabel: 'Web / Mobile', nodeKind: 'frontend', status: 'success', durationMs: 2 },
        { nodeLabel: 'Order Service', nodeKind: 'service', status: 'success', durationMs: 5 },
        { nodeLabel: 'Orders DB', nodeKind: 'database', status: 'failed', durationMs: 12, error: 'Database unavailable' },
      ],
    });

    const trace = traceProjectRequest(blueprintAnalysis, request, response);

    expect(trace.nodeIds).toEqual(expect.arrayContaining(['service', 'web-module', 'web-class', 'order-module', 'order-class']));
    expect(trace.edgeIds).toEqual(expect.arrayContaining(['service-web', 'web-class-edge', 'service-order', 'order-class-edge']));
    expect(trace.probableFailure).toEqual(expect.objectContaining({
      nodeId: 'order-class',
      confidence: 'high',
      title: 'Database unavailable',
    }));
  });
});

function probeInput(method: RequestProbeInput['method'], url: string): RequestProbeInput {
  return { method, url };
}

function probeResult(input: RequestProbeInput, status?: number): RequestProbeResult {
  return {
    id: 'probe', method: input.method, url: input.url, startedAt: new Date(0).toISOString(), durationMs: 12,
    ok: Boolean(status && status < 400), status, statusText: status === 500 ? 'Internal Server Error' : status === 404 ? 'Not Found' : undefined,
    responseHeaders: {}, responseBody: '', responseTruncated: false,
  };
}
