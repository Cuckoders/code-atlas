import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/server/analyzer.js';
import {
  createDemoOtlpPayload,
  parseOtlpJson,
  RuntimeTraceValidationError,
} from '../src/server/runtime-trace.js';
import { mapRuntimeTrace } from '../src/shared/runtime-trace.js';

describe('Runtime Trace', () => {
  it('normalizes OTLP JSON, groups spans and redacts secrets', () => {
    const [session] = parseOtlpJson(createDemoOtlpPayload(), '/projects/commerce');

    expect(session.summary).toEqual(expect.objectContaining({
      projectPath: '/projects/commerce',
      name: 'GET /products',
      status: 'error',
      spanCount: 4,
      errorCount: 1,
      serviceNames: ['commerce-api'],
    }));
    expect(session.summary.durationMs).toBe(148);
    const failure = session.spans.find((span) => span.status === 'error');
    expect(failure?.events[0].attributes).toEqual(expect.objectContaining({
      'exception.type': 'DatabaseTimeoutError',
      authorization: '[REDACTED]',
    }));
  });

  it('rejects malformed telemetry identifiers', () => {
    const payload = createDemoOtlpPayload() as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string }> }> }>;
    };
    payload.resourceSpans[0].scopeSpans[0].spans[0].traceId = 'not-a-trace';

    expect(() => parseOtlpJson(payload, '/projects/commerce')).toThrow(RuntimeTraceValidationError);
  });

  it('maps runtime spans to analyzed nodes and marks the exact failure', async () => {
    const fixturePath = path.resolve('examples/sample-commerce');
    const analysis = await analyzeProject(fixturePath);
    const [session] = parseOtlpJson(createDemoOtlpPayload(), fixturePath);
    const mapped = mapRuntimeTrace(analysis, session);

    expect(mapped.trace.nodeIds.length).toBeGreaterThanOrEqual(3);
    expect(mapped.trace.matchedRoute).toEqual(expect.objectContaining({ method: 'GET', pattern: '/products' }));
    expect(mapped.trace.probableFailure).toEqual(expect.objectContaining({
      confidence: 'high',
      title: 'PostgreSQL query exceeded 75 ms timeout',
      nodeId: expect.any(String),
      reason: 'services/api/src/models.ts:10 · ProductRepository.findAll',
    }));
    expect(mapped.spans.find((span) => span.status === 'error')).toEqual(expect.objectContaining({
      matchReason: 'файл + функция',
      nodeId: expect.any(String),
    }));
  });
});
