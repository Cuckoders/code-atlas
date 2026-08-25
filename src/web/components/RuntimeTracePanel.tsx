import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectAnalysis } from '../../shared/graph';
import {
  formatDuration,
  mapRuntimeTrace,
  type MappedRuntimeTrace,
  type RuntimeTraceSession,
  type RuntimeTraceSummary,
} from '../../shared/runtime-trace';
import type { RequestTrace } from '../../shared/request-trace';
import { apiFetch, resolveBackendUrl } from '../desktop';

interface RuntimeTracePanelProps {
  analysis: ProjectAnalysis;
  open: boolean;
  onClose: () => void;
  onTrace: (trace: RequestTrace | null) => void;
  onSelectNode: (nodeId: string) => void;
}

interface CollectorConfig {
  endpoint: string;
  token: string;
  protocol: string;
  limits: { bodyBytes: number; spansPerBatch: number };
}

export default function RuntimeTracePanel({ analysis, open, onClose, onTrace, onSelectNode }: RuntimeTracePanelProps) {
  const projectPath = analysis.summary.rootPath;
  const [traces, setTraces] = useState<RuntimeTraceSummary[]>([]);
  const [selected, setSelected] = useState<MappedRuntimeTrace | null>(null);
  const [collector, setCollector] = useState<(CollectorConfig & { absoluteEndpoint: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null);

  const loadTraces = useCallback(async () => {
    const response = await apiFetch(`/api/runtime-traces?projectPath=${encodeURIComponent(projectPath)}&limit=24`);
    const payload = await response.json() as RuntimeTraceSummary[] | { error: string };
    if (!response.ok || !Array.isArray(payload)) throw new Error('error' in payload ? payload.error : 'Не удалось загрузить трассировки.');
    setTraces(payload);
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      loadTraces(),
      apiFetch(`/api/runtime-traces/collector?projectPath=${encodeURIComponent(projectPath)}`, { signal: controller.signal })
        .then(async (response) => {
          const config = await response.json() as CollectorConfig | { error: string };
          if (!response.ok || 'error' in config) throw new Error('error' in config ? config.error : 'Коллектор недоступен.');
          setCollector({ ...config, absoluteEndpoint: await resolveBackendUrl(config.endpoint) });
        }),
    ]).catch((loadError) => {
      if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить Runtime Trace.');
      }
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [loadTraces, open, projectPath]);

  const openTrace = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/runtime-traces/${id}`);
      const payload = await response.json() as RuntimeTraceSession | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Trace не найден.');
      const mapped = mapRuntimeTrace(analysis, payload);
      setSelected(mapped);
      onTrace(mapped.trace);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось открыть trace.');
    } finally {
      setLoading(false);
    }
  }, [analysis, onTrace]);

  const createDemo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/runtime-traces/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      const payload = await response.json() as RuntimeTraceSummary | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось создать demo trace.');
      await loadTraces();
      await openTrace(payload.id);
    } catch (demoError) {
      setError(demoError instanceof Error ? demoError.message : 'Не удалось создать demo trace.');
    } finally {
      setLoading(false);
    }
  }, [loadTraces, openTrace, projectPath]);

  const copyValue = async (kind: 'endpoint' | 'token', value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_500);
  };

  const close = () => {
    onClose();
  };

  return (
    <aside className={`runtime-trace-panel ${open ? 'runtime-trace-panel--open' : ''}`} aria-hidden={!open}>
      <header className="runtime-trace-panel__header">
        <div><span>OpenTelemetry</span><h2>Runtime Trace</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть Runtime Trace">×</button>
      </header>

      <section className="runtime-collector">
        <div className="section-heading"><h3>Локальный OTLP collector</h3><i>JSON</i></div>
        {collector ? (
          <>
            <button type="button" onClick={() => void copyValue('endpoint', collector.absoluteEndpoint)}>
              <span>endpoint</span><code>{collector.absoluteEndpoint}</code><i>{copied === 'endpoint' ? 'готово' : 'copy'}</i>
            </button>
            <button type="button" onClick={() => void copyValue('token', collector.token)}>
              <span>header</span><code>x-code-atlas-otlp-token: {maskToken(collector.token)}</code><i>{copied === 'token' ? 'готово' : 'copy'}</i>
            </button>
            <small>OTLP/HTTP JSON · до {collector.limits.spansPerBatch} spans · данные остаются на этом компьютере</small>
          </>
        ) : <p>{loading ? 'Подключаем коллектор…' : 'Конфигурация коллектора недоступна.'}</p>}
      </section>

      <div className="runtime-trace-actions">
        <button type="button" onClick={() => void createDemo()} disabled={loading}>▶ Демо-трасса с ошибкой</button>
        <button type="button" className="is-secondary" onClick={() => void loadTraces()} disabled={loading}>↻ Обновить</button>
      </div>

      {error ? <div className="request-trace-error">{error}</div> : null}

      <section className="runtime-trace-history">
        <div className="section-heading"><h3>Сессии</h3><span>{traces.length}</span></div>
        {traces.length ? (
          <div className="runtime-trace-list">
            {traces.map((trace) => (
              <button
                type="button"
                className={`${trace.status === 'error' ? 'is-error' : ''} ${selected?.session.summary.id === trace.id ? 'is-active' : ''}`}
                key={trace.id}
                onClick={() => void openTrace(trace.id)}
              >
                <i /><span><strong>{trace.name}</strong><small>{trace.serviceNames.join(' → ') || 'unknown-service'}</small></span>
                <em>{formatDuration(trace.durationMs)}<small>{trace.spanCount} spans</small></em>
              </button>
            ))}
          </div>
        ) : <p className="request-trace-empty">Трассировок пока нет. Подключите OTLP exporter или запустите демо.</p>}
      </section>

      {selected ? <RuntimeWaterfall mapped={selected} onSelectNode={onSelectNode} /> : null}
    </aside>
  );
}

function RuntimeWaterfall({ mapped, onSelectNode }: { mapped: MappedRuntimeTrace; onSelectNode: (nodeId: string) => void }) {
  const start = useMemo(() => mapped.spans.reduce((minimum, span) => minNano(minimum, span.startTimeUnixNano), mapped.spans[0]?.startTimeUnixNano ?? '0'), [mapped.spans]);
  const duration = Math.max(mapped.session.summary.durationMs, 0.001);
  const failure = mapped.spans.find((span) => span.status === 'error' || span.events.some((event) => event.name === 'exception'));
  return (
    <section className="runtime-waterfall">
      <div className="section-heading"><h3>Timeline</h3><span>{formatDuration(duration)}</span></div>
      <div className="runtime-waterfall__axis"><span>0</span><span>50%</span><span>{formatDuration(duration)}</span></div>
      <ol>
        {mapped.spans.map((span) => {
          const offset = nanoDeltaMs(start, span.startTimeUnixNano);
          const left = Math.max(0, Math.min(98, offset / duration * 100));
          const width = Math.max(1.8, Math.min(100 - left, span.durationMs / duration * 100));
          return (
            <li className={span.status === 'error' ? 'is-error' : ''} key={span.spanId}>
              <button type="button" disabled={!span.nodeId} onClick={() => span.nodeId && onSelectNode(span.nodeId)}>
                <span><strong>{span.name}</strong><small>{span.serviceName}{span.matchReason ? ` · ${span.matchReason}` : ' · вне карты'}</small></span>
                <em>{formatDuration(span.durationMs)}</em>
                <i style={{ left: `${left}%`, width: `${width}%` }} />
              </button>
            </li>
          );
        })}
      </ol>
      {failure ? (
        <div className="runtime-failure">
          <span>Точное место падения</span>
          <strong>{exceptionAttribute(failure, 'exception.message') ?? failure.statusMessage ?? failure.name}</strong>
          <p>{sourceLocation(failure)}</p>
          {exceptionAttribute(failure, 'exception.stacktrace') ? <pre>{exceptionAttribute(failure, 'exception.stacktrace')}</pre> : null}
        </div>
      ) : <div className="request-trace-success">Trace завершился без зафиксированных ошибок.</div>}
    </section>
  );
}

function maskToken(token: string): string {
  return `${token.slice(0, 8)}••••••••${token.slice(-6)}`;
}

function minNano(left: string, right: string): string {
  return BigInt(left) < BigInt(right) ? left : right;
}

function nanoDeltaMs(start: string, current: string): number {
  return Number(BigInt(current) - BigInt(start)) / 1_000_000;
}

function exceptionAttribute(span: MappedRuntimeTrace['spans'][number], key: string): string | undefined {
  for (const event of span.events) {
    const value = event.attributes[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function sourceLocation(span: MappedRuntimeTrace['spans'][number]): string {
  const file = span.attributes['code.file.path'] ?? span.attributes['code.filepath'];
  const line = span.attributes['code.line.number'];
  const method = span.attributes['code.function.name'] ?? span.name;
  return `${typeof file === 'string' ? file : span.serviceName}${typeof line === 'number' ? `:${line}` : ''} · ${String(method)}`;
}
