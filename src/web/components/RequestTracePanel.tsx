import { useEffect, useRef, useState } from 'react';
import type { AtlasNode, ProjectAnalysis } from '../../shared/graph';
import {
  REQUEST_PROBE_METHODS,
  traceProjectRequest,
  type RequestProbeInput,
  type RequestProbeMethod,
  type RequestProbeResult,
  type RequestTrace,
  type RequestTraceConfidence,
  type RequestTraceRole,
} from '../../shared/request-trace';
import { apiFetch } from '../desktop';
import { TRACE_PLAYBACK_SPEEDS, type TracePlaybackOptions } from '../trace-playback';

interface RequestTracePanelProps {
  analysis: ProjectAnalysis;
  runtimeOrigin?: string;
  open: boolean;
  trace: RequestTrace | null;
  playback: TracePlaybackOptions;
  onClose: () => void;
  onTrace: (trace: RequestTrace | null) => void;
  onPlaybackChange: (playback: TracePlaybackOptions) => void;
  onSelectNode: (nodeId: string) => void;
}

const ROLE_LABEL: Record<RequestTraceRole, string> = {
  service: 'Сервис',
  route: 'Route',
  handler: 'Handler',
  controller: 'Controller',
  function: 'Вызов',
  repository: 'Repository',
  dependency: 'Зависимость',
};

export function RequestTracePanel({
  analysis,
  runtimeOrigin,
  open,
  trace,
  playback,
  onClose,
  onTrace,
  onPlaybackChange,
  onSelectNode,
}: RequestTracePanelProps) {
  const defaults = defaultRequest(analysis.nodes);
  const [method, setMethod] = useState<RequestProbeMethod>(defaults.method);
  const [url, setUrl] = useState(defaults.url);
  const [headersText, setHeadersText] = useState('');
  const [body, setBody] = useState('');
  const [probe, setProbe] = useState<RequestProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    if (runtimeOrigin) setUrl(`${runtimeOrigin.replace(/\/$/, '')}/`);
  }, [runtimeOrigin]);

  const sendRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setSending(true);
    setError(null);
    try {
      const headers = parseHeaders(headersText);
      const input: RequestProbeInput = {
        method,
        url: url.trim(),
        ...(headers ? { headers } : {}),
        ...(allowsBody(method) && body ? { body } : {}),
      };
      const response = await apiFetch('/api/request-probes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const payload = await response.json() as RequestProbeResult | { error: string };
      if (!response.ok) {
        const message = 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Не удалось выполнить запрос.';
        throw new Error(message);
      }
      const probeResult = payload as RequestProbeResult;
      setProbe(probeResult);
      onPlaybackChange({ speed: 1, playing: true });
      onTrace(traceProjectRequest(analysis, input, probeResult));
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : 'Не удалось выполнить запрос.');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setSending(false);
      }
    }
  };

  const clearTrace = () => {
    setProbe(null);
    setError(null);
    onPlaybackChange({ ...playback, playing: false });
    onTrace(null);
  };

  return (
    <aside className={`request-trace-panel ${open ? 'request-trace-panel--open' : ''}`} aria-hidden={!open}>
      <header className="request-trace-panel__header">
        <div><span>Runtime Lab</span><h2>Request Trace</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть Request Trace">×</button>
      </header>

      <form className="request-trace-form" onSubmit={(event) => void sendRequest(event)}>
        <div className="request-trace-form__target">
          <select value={method} onChange={(event) => setMethod(event.target.value as RequestProbeMethod)} aria-label="HTTP method">
            {REQUEST_PROBE_METHODS.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:3000/products"
            aria-label="Локальный URL запроса"
            spellCheck={false}
          />
        </div>
        <label>
          <span>Headers · JSON</span>
          <textarea
            value={headersText}
            onChange={(event) => setHeadersText(event.target.value)}
            placeholder={'{"Authorization":"Bearer …"}'}
            rows={2}
            spellCheck={false}
          />
        </label>
        {allowsBody(method) ? (
          <label>
            <span>Body</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={'{"key":"value"}'}
              rows={4}
              spellCheck={false}
            />
          </label>
        ) : null}
        <small>Только localhost · redirect отключён · данные не сохраняются</small>
        <div className="request-trace-form__actions">
          <button type="submit" disabled={sending || !url.trim()}>{sending ? 'Отправляем…' : 'Отправить запрос'}</button>
          {probe || trace ? <button type="button" className="is-secondary" onClick={clearTrace}>Очистить</button> : null}
        </div>
      </form>

      {error ? <div className="request-trace-error">{error}</div> : null}
      {probe ? <ProbeSummary probe={probe} /> : null}
      {trace ? (
        <section className="request-trace-result">
          <div className="section-heading">
            <h3>Вероятный путь</h3>
            <span>{trace.steps.length}</span>
          </div>
          <div className="trace-playback-compact" aria-label="Скорость анимации Request Trace">
            <button
              type="button"
              className="trace-playback-compact__toggle"
              aria-label={playback.playing ? 'Приостановить анимацию трейса' : 'Продолжить анимацию трейса'}
              onClick={() => onPlaybackChange({ ...playback, playing: !playback.playing })}
            >{playback.playing ? 'Ⅱ Пауза' : '▶ Продолжить'}</button>
            <div role="group" aria-label="Скорость трейса">
              {TRACE_PLAYBACK_SPEEDS.map((speed) => (
                <button
                  type="button"
                  className={playback.speed === speed ? 'is-active' : ''}
                  aria-pressed={playback.speed === speed}
                  key={speed}
                  onClick={() => onPlaybackChange({ ...playback, speed })}
                >{speed}×</button>
              ))}
            </div>
          </div>
          {trace.matchedRoute ? (
            <div className="request-trace-route">
              <span>match</span>
              <strong>{trace.matchedRoute.method} {trace.matchedRoute.pattern}</strong>
            </div>
          ) : <p className="request-trace-empty">Endpoint не найден среди routes текущего снимка.</p>}
          {trace.steps.length ? (
            <ol className="request-trace-steps">
              {trace.steps.map((step, index) => (
                <li className={trace.probableFailure?.nodeId === step.nodeId ? 'is-failure' : ''} key={`${step.nodeId}:${index}`}>
                  <button type="button" onClick={() => onSelectNode(step.nodeId)}>
                    <i>{index + 1}</i>
                    <span><em>{ROLE_LABEL[step.role]}</em><strong>{step.label}</strong><small>{step.detail}</small></span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {trace.probableFailure ? (
            <div className={`request-trace-failure request-trace-failure--${trace.probableFailure.confidence}`}>
              <span>Вероятность · {confidenceLabel(trace.probableFailure.confidence)}</span>
              <strong>{trace.probableFailure.title}</strong>
              <p>{trace.probableFailure.reason}</p>
              {trace.probableFailure.evidence.length ? (
                <ul>{trace.probableFailure.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : null}
            </div>
          ) : <div className="request-trace-success">Явных статических рисков на пути не найдено.</div>}
        </section>
      ) : null}
    </aside>
  );
}

function ProbeSummary({ probe }: { probe: RequestProbeResult }) {
  const status = probe.error ? probe.error.kind : `${probe.status ?? '—'} ${probe.statusText ?? ''}`.trim();
  return (
    <section className="request-probe-summary">
      <div className="section-heading"><h3>Ответ</h3><span>{probe.durationMs} ms</span></div>
      <div className={`request-probe-status ${probe.ok ? 'is-ok' : 'is-error'}`}><i />{status}</div>
      {probe.error ? <p>{probe.error.message}</p> : null}
      {probe.responseBody ? (
        <details>
          <summary>Response preview {probe.responseTruncated ? '· обрезан до 64 КБ' : ''}</summary>
          <pre>{probe.responseBody}</pre>
        </details>
      ) : null}
    </section>
  );
}

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Headers должны быть корректным JSON-объектом.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Headers должны быть JSON-объектом.');
  }
  const entries = Object.entries(parsed);
  if (entries.length > 20 || entries.some(([, headerValue]) => typeof headerValue !== 'string')) {
    throw new Error('Допускается до 20 строковых HTTP-заголовков.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function defaultRequest(nodes: AtlasNode[]): { method: RequestProbeMethod; url: string } {
  for (const node of nodes) {
    const route = node.members?.find((member) => member.kind === 'route');
    const match = route ? /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(route.name) : null;
    if (!match) continue;
    const method = match[1].toUpperCase() as RequestProbeMethod;
    const pathname = match[2]
      .replace(/:[A-Za-z_][A-Za-z0-9_?]*/g, 'demo')
      .replace(/\{[^}]+\}|<[^>]+>|\[[^\]]+\]/g, 'demo');
    return { method, url: `http://127.0.0.1:3000${pathname.startsWith('/') ? pathname : `/${pathname}`}` };
  }
  return { method: 'GET', url: 'http://127.0.0.1:3000/' };
}

function allowsBody(method: RequestProbeMethod): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function confidenceLabel(confidence: RequestTraceConfidence): string {
  return confidence === 'high' ? 'высокая' : confidence === 'medium' ? 'средняя' : 'низкая';
}
