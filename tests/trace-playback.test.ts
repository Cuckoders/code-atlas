import { describe, expect, it } from 'vitest';
import type { MappedRuntimeTrace } from '../src/shared/runtime-trace.js';
import { runtimeFailureIndex, runtimeStepDelay, traceAtRuntimeSpan } from '../src/web/trace-playback.js';

describe('trace playback', () => {
  it('reveals the mapped path incrementally and exposes failure only when reached', () => {
    const mapped = fixture();
    expect(traceAtRuntimeSpan(mapped, 0)).toMatchObject({ nodeIds: ['service'], edgeIds: [] });
    expect(traceAtRuntimeSpan(mapped, 1)).toMatchObject({ nodeIds: ['service', 'controller'], edgeIds: ['edge-1'] });
    expect(traceAtRuntimeSpan(mapped, 1).probableFailure).toBeUndefined();
    expect(traceAtRuntimeSpan(mapped, 2).probableFailure?.nodeId).toBe('database');
    expect(runtimeFailureIndex(mapped)).toBe(2);
  });

  it('scales readable step delays with playback speed', () => {
    expect(runtimeStepDelay(10, 2)).toBeLessThan(runtimeStepDelay(10, 1));
    expect(runtimeStepDelay(100_000, 1)).toBe(1_400);
  });
});

function fixture(): MappedRuntimeTrace {
  const spans = [
    span('span-1', 'service', 'ok'),
    span('span-2', 'controller', 'ok'),
    span('span-3', 'database', 'error'),
  ];
  return {
    session: {
      summary: {
        id: 'session', projectPath: '/tmp/project', traceId: 'trace', name: 'request',
        createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 30, status: 'error', spanCount: 3, errorCount: 1, serviceNames: ['api'],
      },
      spans,
    },
    spans,
    trace: {
      steps: [
        { nodeId: 'service', role: 'service', label: 'API', detail: 'api' },
        { nodeId: 'controller', edgeId: 'edge-1', role: 'controller', label: 'Controller', detail: 'api' },
        { nodeId: 'database', edgeId: 'edge-2', role: 'dependency', label: 'DB', detail: 'db' },
      ],
      nodeIds: ['service', 'controller', 'database'],
      edgeIds: ['edge-1', 'edge-2'],
      probableFailure: { nodeId: 'database', confidence: 'high', title: 'DB error', reason: 'query', evidence: [] },
    },
  };
}

function span(spanId: string, nodeId: string, status: 'ok' | 'error'): MappedRuntimeTrace['spans'][number] {
  return {
    traceId: 'trace', spanId, name: spanId, serviceName: 'api', kind: 1,
    startTimeUnixNano: '1000000', endTimeUnixNano: '2000000', durationMs: 1,
    status, attributes: {}, events: [], nodeId,
  };
}
