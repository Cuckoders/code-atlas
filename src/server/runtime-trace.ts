import { randomUUID } from 'node:crypto';
import type {
  RuntimeAttributeValue,
  RuntimeSpan,
  RuntimeSpanEvent,
  RuntimeSpanStatus,
  RuntimeTraceSession,
} from '../shared/runtime-trace.js';

export const MAX_OTLP_JSON_SIZE = 1024 * 1024;
export const MAX_OTLP_SPANS = 500;
const MAX_ATTRIBUTES = 64;
const MAX_EVENTS = 32;
const MAX_STRING = 4_096;
const MAX_STACK = 12_288;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[._-]?key|credential)/i;

export class RuntimeTraceValidationError extends Error {}

export function parseOtlpJson(payload: unknown, projectPath: string): RuntimeTraceSession[] {
  if (!isRecord(payload) || !Array.isArray(payload.resourceSpans)) {
    throw new RuntimeTraceValidationError('Ожидался OTLP/HTTP JSON с массивом resourceSpans.');
  }
  const spans: RuntimeSpan[] = [];
  for (const resourceSpan of payload.resourceSpans) {
    if (!isRecord(resourceSpan)) throw new RuntimeTraceValidationError('Некорректный resourceSpans.');
    const resourceAttributes = readAttributes(isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined);
    const serviceName = limitedString(resourceAttributes['service.name'], 'unknown-service', 128);
    const groups = Array.isArray(resourceSpan.scopeSpans)
      ? resourceSpan.scopeSpans
      : Array.isArray(resourceSpan.instrumentationLibrarySpans) ? resourceSpan.instrumentationLibrarySpans : [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.spans)) continue;
      for (const value of group.spans) {
        spans.push(readSpan(value, serviceName));
        if (spans.length > MAX_OTLP_SPANS) {
          throw new RuntimeTraceValidationError(`Один пакет может содержать не более ${MAX_OTLP_SPANS} spans.`);
        }
      }
    }
  }
  if (!spans.length) throw new RuntimeTraceValidationError('OTLP-пакет не содержит spans.');
  const byTrace = new Map<string, RuntimeSpan[]>();
  for (const span of spans) {
    const group = byTrace.get(span.traceId) ?? [];
    group.push(span);
    byTrace.set(span.traceId, group);
  }
  return [...byTrace.entries()].map(([traceId, traceSpans]) => createSession(projectPath, traceId, traceSpans));
}

export function createDemoOtlpPayload(): unknown {
  const traceId = '4fd0b7c0a1e947f08d2be78b9a3d5510';
  const base = BigInt(Date.now()) * 1_000_000n;
  const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const span = (
    spanId: string,
    parentSpanId: string | undefined,
    name: string,
    startMs: number,
    durationMs: number,
    attributes: unknown[],
    error?: { type: string; message: string; stack: string },
  ) => ({
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: parentSpanId ? 3 : 2,
    startTimeUnixNano: String(base + BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(base + BigInt(startMs + durationMs) * 1_000_000n),
    attributes,
    status: error ? { code: 2, message: error.message } : { code: 1 },
    events: error ? [{
      name: 'exception',
      timeUnixNano: String(base + BigInt(startMs + durationMs - 2) * 1_000_000n),
      attributes: [
        attribute('exception.type', error.type),
        attribute('exception.message', error.message),
        attribute('exception.stacktrace', error.stack),
        attribute('authorization', 'Bearer should-not-be-stored'),
      ],
    }] : [],
  });
  return {
    resourceSpans: [{
      resource: { attributes: [attribute('service.name', 'commerce-api')] },
      scopeSpans: [{
        scope: { name: 'code-atlas.demo' },
        spans: [
          span('0000000000000001', undefined, 'GET /products', 0, 148, [
            attribute('http.request.method', 'GET'),
            attribute('http.route', '/products'),
            attribute('code.file.path', 'services/api/src/catalog.controller.ts'),
            attribute('code.function.name', 'registerCatalogRoutes'),
          ]),
          span('0000000000000002', '0000000000000001', 'CatalogController.listProducts', 8, 118, [
            attribute('code.file.path', 'services/api/src/catalog.controller.ts'),
            attribute('code.function.name', 'CatalogController.listProducts'),
          ]),
          span('0000000000000003', '0000000000000002', 'ProductRepository.findAll', 22, 91, [
            attribute('code.file.path', 'services/api/src/models.ts'),
            attribute('code.function.name', 'ProductRepository.findAll'),
          ]),
          span('0000000000000004', '0000000000000003', 'SELECT products', 31, 76, [
            attribute('db.system', 'postgresql'),
            attribute('db.operation.name', 'SELECT'),
            attribute('code.file.path', 'services/api/src/models.ts'),
            attribute('code.function.name', 'ProductRepository.findAll'),
            { key: 'code.line.number', value: { intValue: 10 } },
          ], {
            type: 'DatabaseTimeoutError',
            message: 'PostgreSQL query exceeded 75 ms timeout',
            stack: 'DatabaseTimeoutError: query timeout\n    at ProductRepository.findAll (services/api/src/models.ts:10:12)',
          }),
        ],
      }],
    }],
  };
}

function readSpan(value: unknown, serviceName: string): RuntimeSpan {
  if (!isRecord(value)) throw new RuntimeTraceValidationError('Некорректный span.');
  const traceId = requiredHex(value.traceId, 32, 'traceId');
  const spanId = requiredHex(value.spanId, 16, 'spanId');
  const parentSpanId = optionalHex(value.parentSpanId, 16, 'parentSpanId');
  const name = limitedString(value.name, 'unnamed span', 256);
  const startTimeUnixNano = requiredNano(value.startTimeUnixNano, 'startTimeUnixNano');
  const endTimeUnixNano = requiredNano(value.endTimeUnixNano, 'endTimeUnixNano');
  const durationMs = nanoDuration(startTimeUnixNano, endTimeUnixNano);
  const statusRecord = isRecord(value.status) ? value.status : {};
  const status = readStatus(statusRecord.code);
  const statusMessage = limitedOptionalString(statusRecord.message, MAX_STRING);
  const attributes = readAttributes(value.attributes);
  const events = readEvents(value.events);
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    serviceName,
    kind: typeof value.kind === 'number' && Number.isInteger(value.kind) ? Math.max(0, Math.min(value.kind, 5)) : 0,
    startTimeUnixNano,
    endTimeUnixNano,
    durationMs,
    status,
    ...(statusMessage ? { statusMessage } : {}),
    attributes,
    events,
  };
}

function createSession(projectPath: string, traceId: string, spans: RuntimeSpan[]): RuntimeTraceSession {
  const sorted = spans.slice().sort((left, right) => compareNano(left.startTimeUnixNano, right.startTimeUnixNano));
  const earliest = sorted[0];
  const latestEnd = sorted.reduce((latest, span) => compareNano(span.endTimeUnixNano, latest) > 0 ? span.endTimeUnixNano : latest, earliest.endTimeUnixNano);
  const errorCount = sorted.filter((span) => span.status === 'error' || span.events.some((event) => event.name === 'exception')).length;
  const root = sorted.find((span) => !span.parentSpanId || !sorted.some((candidate) => candidate.spanId === span.parentSpanId)) ?? earliest;
  return {
    summary: {
      id: randomUUID(),
      projectPath,
      traceId,
      name: root.name,
      createdAt: new Date().toISOString(),
      startedAt: nanoToIso(earliest.startTimeUnixNano),
      durationMs: nanoDuration(earliest.startTimeUnixNano, latestEnd),
      status: errorCount ? 'error' : sorted.some((span) => span.status === 'ok') ? 'ok' : 'unset',
      spanCount: sorted.length,
      errorCount,
      serviceNames: [...new Set(sorted.map((span) => span.serviceName))].sort(),
    },
    spans: sorted,
  };
}

function readAttributes(value: unknown): Record<string, RuntimeAttributeValue> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, RuntimeAttributeValue> = {};
  for (const item of value.slice(0, MAX_ATTRIBUTES)) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key || item.key.length > 256) continue;
    if (SENSITIVE_KEY.test(item.key)) {
      result[item.key] = '[REDACTED]';
      continue;
    }
    const parsed = readAnyValue(item.value, item.key === 'exception.stacktrace' ? MAX_STACK : MAX_STRING);
    if (parsed !== undefined) result[item.key] = parsed;
  }
  return result;
}

function readEvents(value: unknown): RuntimeSpanEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_EVENTS).flatMap((event) => {
    if (!isRecord(event)) return [];
    const name = limitedOptionalString(event.name, 128);
    if (!name) return [];
    const timeUnixNano = typeof event.timeUnixNano === 'string' && /^\d{1,20}$/.test(event.timeUnixNano)
      ? event.timeUnixNano
      : undefined;
    return [{ name, ...(timeUnixNano ? { timeUnixNano } : {}), attributes: readAttributes(event.attributes) }];
  });
}

function readAnyValue(value: unknown, maxLength: number): RuntimeAttributeValue | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.stringValue === 'string') return truncate(value.stringValue, maxLength);
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.intValue === 'string' && /^-?\d{1,20}$/.test(value.intValue)) {
    const number = Number(value.intValue);
    return Number.isSafeInteger(number) ? number : truncate(value.intValue, maxLength);
  }
  if (typeof value.intValue === 'number' && Number.isSafeInteger(value.intValue)) return value.intValue;
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  return undefined;
}

function readStatus(value: unknown): RuntimeSpanStatus {
  return value === 2 || value === 'STATUS_CODE_ERROR' ? 'error'
    : value === 1 || value === 'STATUS_CODE_OK' ? 'ok'
      : 'unset';
}

function requiredHex(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) {
    throw new RuntimeTraceValidationError(`${field} должен быть ${length}-символьным hex ID.`);
  }
  return value.toLowerCase();
}

function optionalHex(value: unknown, length: number, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requiredHex(value, length, field);
}

function requiredNano(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw new RuntimeTraceValidationError(`${field} должен быть nanosecond timestamp.`);
  }
  return value;
}

function nanoDuration(start: string, end: string): number {
  const delta = BigInt(end) - BigInt(start);
  if (delta < 0n) throw new RuntimeTraceValidationError('Время окончания span раньше времени начала.');
  return Number(delta) / 1_000_000;
}

function nanoToIso(value: string): string {
  const milliseconds = Number(BigInt(value) / 1_000_000n);
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.valueOf())) {
    throw new RuntimeTraceValidationError('Timestamp span находится вне поддерживаемого диапазона.');
  }
  return date.toISOString();
}

function compareNano(left: string, right: string): number {
  const delta = BigInt(left) - BigInt(right);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function limitedString(value: unknown, fallback: string, maxLength: number): string {
  return limitedOptionalString(value, maxLength) ?? fallback;
}

function limitedOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return truncate(value.trim(), maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
