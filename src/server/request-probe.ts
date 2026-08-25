import { randomUUID } from 'node:crypto';
import type {
  RequestProbeErrorKind,
  RequestProbeInput,
  RequestProbeResult,
} from '../shared/request-trace.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'server-timing',
  'traceparent',
  'x-request-id',
  'x-trace-id',
]);
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BODY_BYTES = 12 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

export class RequestProbeValidationError extends Error {}

export async function executeRequestProbe(input: RequestProbeInput): Promise<RequestProbeResult> {
  const target = validateProbeInput(input);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const headers = new Headers(input.headers);
  if (input.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  try {
    const response = await fetch(target, {
      method: input.method,
      headers,
      body: input.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readLimitedBody(response.body);
    return {
      id: randomUUID(),
      method: input.method,
      url: target.href,
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: selectResponseHeaders(response.headers),
      responseBody: body.text,
      responseTruncated: body.truncated,
    };
  } catch (error) {
    const classified = classifyProbeError(error);
    return {
      id: randomUUID(),
      method: input.method,
      url: target.href,
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      ok: false,
      responseHeaders: {},
      responseBody: '',
      responseTruncated: false,
      error: classified,
    };
  }
}

function validateProbeInput(input: RequestProbeInput): URL {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    throw new RequestProbeValidationError('Укажите корректный абсолютный URL.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new RequestProbeValidationError('Разрешены только HTTP и HTTPS запросы.');
  }
  if (!LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
    throw new RequestProbeValidationError('Request Trace разрешает запросы только к localhost/loopback.');
  }
  if (target.username || target.password) {
    throw new RequestProbeValidationError('Credentials в URL запрещены; используйте заголовок Authorization.');
  }
  if ((input.method === 'GET' || input.method === 'HEAD') && input.body) {
    throw new RequestProbeValidationError(`${input.method} запрос не должен содержать body.`);
  }
  if (Buffer.byteLength(input.body ?? '', 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new RequestProbeValidationError('Request body превышает лимит 12 КБ.');
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (BLOCKED_HEADERS.has(normalizedName)) {
      throw new RequestProbeValidationError(`Заголовок ${name} запрещён в Request Trace.`);
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new RequestProbeValidationError('Некорректный HTTP-заголовок.');
    }
  }
  return target;
}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    const remaining = MAX_RESPONSE_BODY_BYTES - bytes;
    if (part.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(part.value.subarray(0, remaining));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(part.value);
    bytes += part.value.byteLength;
    if (bytes === MAX_RESPONSE_BODY_BYTES) {
      const next = await reader.read();
      truncated = !next.done;
      if (!next.done) await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function selectResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) selected[name.toLowerCase()] = value;
  }
  return selected;
}

function classifyProbeError(error: unknown): { kind: RequestProbeErrorKind; message: string } {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { kind: 'timeout', message: `Сервис не ответил за ${REQUEST_TIMEOUT_MS / 1_000} секунд.` };
  }
  const code = errorCode(error);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return { kind: 'connection', message: 'Соединение с локальным сервисом отклонено или сброшено.' };
  }
  if (code?.startsWith('CERT_') || code?.includes('TLS')) {
    return { kind: 'tls', message: 'Не удалось установить защищённое соединение с локальным сервисом.' };
  }
  return { kind: 'network', message: 'Локальный HTTP-запрос завершился сетевой ошибкой.' };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('cause' in error)) return undefined;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}
