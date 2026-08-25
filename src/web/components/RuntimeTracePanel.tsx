import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ProjectAnalysis } from '../../shared/graph';
import {
  formatDuration,
  mapRuntimeTrace,
  type MappedRuntimeSpan,
  type MappedRuntimeTrace,
  type RuntimeTraceSession,
  type RuntimeTraceSummary,
} from '../../shared/runtime-trace';
import type { RequestTrace } from '../../shared/request-trace';
import { apiFetch, resolveBackendUrl } from '../desktop';
import {
  TRACE_PLAYBACK_SPEEDS,
  runtimeFailureIndex,
  runtimeStepDelay,
  traceAtRuntimeSpan,
  type TracePlaybackOptions,
} from '../trace-playback';

interface RuntimeTracePanelProps {
  analysis: ProjectAnalysis;
  open: boolean;
  playback: TracePlaybackOptions;
  onClose: () => void;
  onTrace: (trace: RequestTrace | null) => void;
  onPlaybackChange: (playback: TracePlaybackOptions) => void;
  onSelectNode: (nodeId: string) => void;
}

interface CollectorConfig {
  endpoint: string;
  token: string;
  protocol: string;
  limits: { bodyBytes: number; spansPerBatch: number };
}

type SessionFilter = 'all' | 'error' | 'ok';

const SESSION_DATE = new Intl.DateTimeFormat('ru', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export default function RuntimeTracePanel({
  analysis,
  open,
  playback,
  onClose,
  onTrace,
  onPlaybackChange,
  onSelectNode,
}: RuntimeTracePanelProps) {
  const projectPath = analysis.summary.rootPath;
  const [traces, setTraces] = useState<RuntimeTraceSummary[]>([]);
  const [selected, setSelected] = useState<MappedRuntimeTrace | null>(null);
  const [collector, setCollector] = useState<(CollectorConfig & { absoluteEndpoint: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const deferredSessionQuery = useDeferredValue(sessionQuery.trim().toLowerCase());
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [breakpoints, setBreakpoints] = useState<Set<string>>(() => new Set());
  const [timelineZoom, setTimelineZoom] = useState(1);

  const loadTraces = useCallback(async (signal?: AbortSignal) => {
    const response = await apiFetch(`/api/runtime-traces?projectPath=${encodeURIComponent(projectPath)}&limit=50`, { signal });
    const payload = await response.json() as RuntimeTraceSummary[] | { error: string };
    if (!response.ok || !Array.isArray(payload)) throw new Error('error' in payload ? payload.error : 'Не удалось загрузить трассировки.');
    setTraces(payload);
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSelected(null);
    setSessionsCollapsed(false);
    setLoading(true);
    setError(null);
    void Promise.all([
      loadTraces(controller.signal),
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
      setPlayhead(0);
      setBreakpoints(new Set());
      setTimelineZoom(1);
      setSessionsCollapsed(true);
      onPlaybackChange({ speed: playback.speed, playing: false });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось открыть trace.');
    } finally {
      setLoading(false);
    }
  }, [analysis, onPlaybackChange, playback.speed]);

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

  useEffect(() => {
    const latest = traces[0];
    if (!open || loading || selected || !latest) return;
    void openTrace(latest.id);
  }, [loading, open, openTrace, selected, traces]);

  useEffect(() => {
    if (!selected) return;
    onTrace(traceAtRuntimeSpan(selected, playhead));
  }, [onTrace, playhead, selected]);

  useEffect(() => {
    if (!selected || !playback.playing || selected.spans.length === 0) return;
    if (playhead >= selected.spans.length - 1) {
      onPlaybackChange({ ...playback, playing: false });
      return;
    }
    const nextIndex = playhead + 1;
    const timeout = window.setTimeout(() => {
      setPlayhead(nextIndex);
      if (breakpoints.has(selected.spans[nextIndex].spanId) || nextIndex === selected.spans.length - 1) {
        onPlaybackChange({ ...playback, playing: false });
      }
    }, runtimeStepDelay(selected.spans[playhead].durationMs, playback.speed));
    return () => window.clearTimeout(timeout);
  }, [breakpoints, onPlaybackChange, playback, playhead, selected]);

  const visibleTraces = useMemo(() => traces.filter((trace) => {
    const hasError = trace.status === 'error' || trace.errorCount > 0;
    if (sessionFilter === 'error' && !hasError) return false;
    if (sessionFilter === 'ok' && hasError) return false;
    if (!deferredSessionQuery) return true;
    return `${trace.name} ${trace.serviceNames.join(' ')} ${trace.traceId}`.toLowerCase().includes(deferredSessionQuery);
  }), [deferredSessionQuery, sessionFilter, traces]);

  const copyValue = async (kind: 'endpoint' | 'token', value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_500);
  };

  const close = () => {
    onPlaybackChange({ ...playback, playing: false });
    onClose();
  };

  const setPlaying = (playing: boolean) => {
    if (!selected) return;
    if (playing && playhead >= selected.spans.length - 1) setPlayhead(0);
    onPlaybackChange({ ...playback, playing });
  };

  const movePlayhead = (next: number) => {
    if (!selected) return;
    setPlayhead(Math.max(0, Math.min(selected.spans.length - 1, next)));
    onPlaybackChange({ ...playback, playing: false });
  };

  const toggleBreakpoint = (spanId: string) => {
    setBreakpoints((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId); else next.add(spanId);
      return next;
    });
  };

  return (
    <aside className={`runtime-trace-panel ${open ? 'runtime-trace-panel--open' : ''}`} aria-hidden={!open} aria-label="Отладчик Runtime Trace">
      <header className="runtime-trace-panel__header">
        <div><span>OpenTelemetry Debugger</span><h2>Runtime Trace</h2></div>
        {selected ? <div className={`runtime-trace-panel__state ${selected.session.summary.status === 'error' ? 'is-error' : ''}`}><i />{selected.session.summary.status === 'error' ? 'Ошибка' : 'Завершён'}</div> : null}
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть Runtime Trace">×</button>
      </header>

      <div className="runtime-trace-panel__scroll">
        <details className="runtime-collector">
          <summary><span>OTLP collector</span><strong>{collector ? 'Подключение готово' : loading ? 'Подключаем…' : 'Недоступен'}</strong></summary>
          <div className="runtime-collector__content">
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
            ) : <p>Конфигурация коллектора недоступна.</p>}
          </div>
        </details>

        <div className="runtime-trace-actions">
          <button type="button" onClick={() => void createDemo()} disabled={loading}>▶ Демо с ошибкой</button>
          <button type="button" className="is-secondary" onClick={() => void loadTraces()} disabled={loading}>↻ Обновить сессии</button>
        </div>

        {error ? <div className="request-trace-error" role="alert">{error}</div> : null}

        <section className="runtime-trace-history">
          <div className="section-heading">
            <h3>Сессии</h3>
            <div className="runtime-session-heading-actions">
              <span>{visibleTraces.length} из {traces.length}</span>
              {selected ? <button type="button" aria-expanded={!sessionsCollapsed} onClick={() => setSessionsCollapsed((value) => !value)}>{sessionsCollapsed ? 'Показать список' : 'Свернуть список'}</button> : null}
            </div>
          </div>
          {!sessionsCollapsed ? (
            <>
              <div className="runtime-session-toolbar">
                <label><span aria-hidden="true">⌕</span><input name="trace-session-search" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="Сервис, trace ID…" aria-label="Поиск trace-сессий" autoComplete="off" spellCheck={false} /></label>
                <div role="group" aria-label="Статус trace-сессии">
                  {(['all', 'error', 'ok'] as const).map((filter) => (
                    <button type="button" className={sessionFilter === filter ? 'is-active' : ''} aria-pressed={sessionFilter === filter} key={filter} onClick={() => setSessionFilter(filter)}>{filter === 'all' ? 'Все' : filter === 'error' ? 'Ошибки' : 'Успешные'}</button>
                  ))}
                </div>
              </div>
              {visibleTraces.length ? (
                <div className="runtime-trace-list">
                  {visibleTraces.map((trace) => {
                    const hasError = trace.status === 'error' || trace.errorCount > 0;
                    return (
                      <button type="button" className={`${hasError ? 'is-error' : ''} ${selected?.session.summary.id === trace.id ? 'is-active' : ''}`} key={trace.id} onClick={() => void openTrace(trace.id)}>
                        <span className="runtime-session-status"><i />{hasError ? `${trace.errorCount || 1} error` : 'ok'}</span>
                        <span className="runtime-session-main"><strong>{trace.name}</strong><small>{trace.serviceNames.join(' → ') || 'unknown-service'}</small><code>{trace.traceId.slice(0, 16)}…</code></span>
                        <span className="runtime-session-meta"><time dateTime={trace.createdAt}>{SESSION_DATE.format(new Date(trace.createdAt))}</time><em>{formatDuration(trace.durationMs)} · {trace.spanCount} spans</em></span>
                      </button>
                    );
                  })}
                </div>
              ) : <p className="request-trace-empty">Сессии не найдены. Измените фильтр или подключите OTLP exporter.</p>}
            </>
          ) : (
            <div className={`runtime-session-collapsed ${selected?.session.summary.status === 'error' ? 'is-error' : ''}`}><span>● {selected?.session.summary.status === 'error' ? 'error' : 'ok'}</span><strong>{selected?.session.summary.name}</strong><code>{selected?.session.summary.traceId.slice(0, 16)}…</code></div>
          )}
        </section>

        {selected ? (
          <RuntimeDebugger
            mapped={selected}
            playback={playback}
            playhead={playhead}
            breakpoints={breakpoints}
            timelineZoom={timelineZoom}
            onTimelineZoom={setTimelineZoom}
            onPlaybackChange={onPlaybackChange}
            onPlayingChange={setPlaying}
            onMovePlayhead={movePlayhead}
            onToggleBreakpoint={toggleBreakpoint}
            onSelectNode={onSelectNode}
          />
        ) : <div className="runtime-trace-placeholder"><span>⌁</span><strong>Выберите сессию</strong><p>Откроются управление воспроизведением, timeline spans и точное место ошибки.</p></div>}
      </div>
    </aside>
  );
}

function RuntimeDebugger({
  mapped, playback, playhead, breakpoints, timelineZoom, onTimelineZoom, onPlaybackChange,
  onPlayingChange, onMovePlayhead, onToggleBreakpoint, onSelectNode,
}: {
  mapped: MappedRuntimeTrace;
  playback: TracePlaybackOptions;
  playhead: number;
  breakpoints: Set<string>;
  timelineZoom: number;
  onTimelineZoom: (zoom: number) => void;
  onPlaybackChange: (playback: TracePlaybackOptions) => void;
  onPlayingChange: (playing: boolean) => void;
  onMovePlayhead: (index: number) => void;
  onToggleBreakpoint: (spanId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const failureIndex = runtimeFailureIndex(mapped);
  const failure = failureIndex >= 0 ? mapped.spans[failureIndex] : undefined;
  const activeSpan = mapped.spans[playhead];
  return (
    <section className="runtime-debugger">
      <header className="runtime-debugger__summary">
        <div><span>Активная сессия</span><h3>{mapped.session.summary.name}</h3><code>{mapped.session.summary.traceId}</code></div>
        <dl><div><dt>Duration</dt><dd>{formatDuration(mapped.session.summary.durationMs)}</dd></div><div><dt>Spans</dt><dd>{mapped.spans.length}</dd></div><div><dt>Services</dt><dd>{mapped.session.summary.serviceNames.length}</dd></div></dl>
      </header>

      <div className="runtime-playback">
        <div className="runtime-playback__transport" role="group" aria-label="Управление воспроизведением trace">
          <button type="button" onClick={() => onMovePlayhead(0)} aria-label="В начало">↤</button>
          <button type="button" onClick={() => onMovePlayhead(playhead - 1)} disabled={playhead === 0} aria-label="Предыдущий span">←</button>
          <button type="button" className="is-primary" onClick={() => onPlayingChange(!playback.playing)} aria-label={playback.playing ? 'Поставить trace на паузу' : 'Запустить trace'}>{playback.playing ? 'Ⅱ' : '▶'}</button>
          <button type="button" onClick={() => onMovePlayhead(playhead + 1)} disabled={playhead >= mapped.spans.length - 1} aria-label="Следующий span">→</button>
        </div>
        <label className="runtime-playback__scrubber">
          <span>{playhead + 1} / {mapped.spans.length}</span>
          <input name="trace-playhead" type="range" min={0} max={Math.max(0, mapped.spans.length - 1)} value={playhead} onChange={(event) => onMovePlayhead(Number(event.target.value))} aria-label="Позиция воспроизведения trace" />
          <strong title={activeSpan?.name}>{activeSpan?.name ?? '—'}</strong>
        </label>
        <div className="runtime-playback__speed" role="group" aria-label="Скорость Runtime Trace">
          {TRACE_PLAYBACK_SPEEDS.map((speed) => <button type="button" className={playback.speed === speed ? 'is-active' : ''} aria-pressed={playback.speed === speed} key={speed} onClick={() => onPlaybackChange({ ...playback, speed })}>{speed}×</button>)}
        </div>
      </div>

      {failure ? <RuntimeFailureInspector span={failure} reached={playhead >= failureIndex} onReveal={() => { onMovePlayhead(failureIndex); if (failure.nodeId) onSelectNode(failure.nodeId); }} /> : <div className="request-trace-success">Trace завершился без зафиксированных ошибок.</div>}

      <RuntimeTimeline mapped={mapped} playhead={playhead} breakpoints={breakpoints} zoom={timelineZoom} onZoom={onTimelineZoom} onSelect={(index) => { onMovePlayhead(index); const nodeId = mapped.spans[index].nodeId; if (nodeId) onSelectNode(nodeId); }} onToggleBreakpoint={onToggleBreakpoint} />
    </section>
  );
}

function RuntimeTimeline({ mapped, playhead, breakpoints, zoom, onZoom, onSelect, onToggleBreakpoint }: {
  mapped: MappedRuntimeTrace;
  playhead: number;
  breakpoints: Set<string>;
  zoom: number;
  onZoom: (zoom: number) => void;
  onSelect: (index: number) => void;
  onToggleBreakpoint: (spanId: string) => void;
}) {
  const start = useMemo(() => mapped.spans.reduce((minimum, span) => minNano(minimum, span.startTimeUnixNano), mapped.spans[0]?.startTimeUnixNano ?? '0'), [mapped.spans]);
  const duration = Math.max(mapped.session.summary.durationMs, 0.001);
  const depths = useMemo(() => spanDepths(mapped.spans), [mapped.spans]);
  return (
    <section className="runtime-timeline">
      <div className="runtime-timeline__header">
        <div className="section-heading"><h3>Timeline</h3><span>{formatDuration(duration)}</span></div>
        <div role="group" aria-label="Масштаб timeline">{[1, 2, 4].map((value) => <button type="button" className={zoom === value ? 'is-active' : ''} aria-pressed={zoom === value} key={value} onClick={() => onZoom(value)}>{value}×</button>)}</div>
      </div>
      <p className="runtime-timeline__hint"><i /> breakpoint · нажмите слева от span</p>
      <div className="runtime-timeline__viewport">
        <div className="runtime-timeline__content" style={{ width: `${zoom * 100}%` }}>
          <div className="runtime-waterfall__axis"><span>0</span><span>25%</span><span>50%</span><span>75%</span><span>{formatDuration(duration)}</span></div>
          <ol>
            {mapped.spans.map((span, index) => {
              const offset = nanoDeltaMs(start, span.startTimeUnixNano);
              const left = Math.max(0, Math.min(98, offset / duration * 100));
              const width = Math.max(1.4, Math.min(100 - left, span.durationMs / duration * 100));
              const breakpoint = breakpoints.has(span.spanId);
              return (
                <li className={`${span.status === 'error' ? 'is-error' : ''} ${playhead === index ? 'is-active' : ''} ${index < playhead ? 'is-past' : ''}`} key={span.spanId}>
                  <button type="button" className={`runtime-breakpoint ${breakpoint ? 'is-active' : ''}`} aria-label={`${breakpoint ? 'Убрать' : 'Поставить'} точку остановки на ${span.name}`} aria-pressed={breakpoint} onClick={() => onToggleBreakpoint(span.spanId)}><span /></button>
                  <button type="button" className="runtime-span-row" onClick={() => onSelect(index)}>
                    <span className="runtime-span-row__label" style={{ paddingLeft: `${Math.min(5, depths.get(span.spanId) ?? 0) * 9}px` }}><strong>{span.name}</strong><small>{span.serviceName}{span.matchReason ? ` · ${span.matchReason}` : ' · вне карты'}</small></span>
                    <span className="runtime-span-row__track"><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
                    <em>{formatDuration(span.durationMs)}</em>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

function RuntimeFailureInspector({ span, reached, onReveal }: { span: MappedRuntimeSpan; reached: boolean; onReveal: () => void }) {
  const stack = exceptionAttribute(span, 'exception.stacktrace');
  const message = exceptionAttribute(span, 'exception.message') ?? span.statusMessage ?? span.name;
  return (
    <section className={`runtime-failure ${reached ? 'is-reached' : ''}`} aria-label="Место ошибки">
      <header><div><span>Точное место падения</span><strong>{message}</strong></div><button type="button" onClick={onReveal}>Показать на карте</button></header>
      <dl><div><dt>Сервис</dt><dd>{span.serviceName}</dd></div><div><dt>Span</dt><dd>{span.name}</dd></div><div><dt>Время</dt><dd>{formatDuration(span.durationMs)}</dd></div><div><dt>Код</dt><dd>{sourceLocation(span)}</dd></div></dl>
      {stack ? <details><summary>Stack trace</summary><pre>{stack}</pre></details> : <p>Stack trace не передан exporter-ом. Добавьте exception.stacktrace в событие span.</p>}
      {!reached ? <small>Ошибка находится дальше текущей позиции воспроизведения.</small> : null}
    </section>
  );
}

function spanDepths(spans: MappedRuntimeSpan[]): Map<string, number> {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const result = new Map<string, number>();
  const depthFor = (span: MappedRuntimeSpan, seen = new Set<string>()): number => {
    if (!span.parentSpanId || seen.has(span.spanId)) return 0;
    const parent = byId.get(span.parentSpanId);
    if (!parent) return 0;
    seen.add(span.spanId);
    return 1 + depthFor(parent, seen);
  };
  for (const span of spans) result.set(span.spanId, depthFor(span));
  return result;
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

function exceptionAttribute(span: MappedRuntimeSpan, key: string): string | undefined {
  for (const event of span.events) {
    const value = event.attributes[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function sourceLocation(span: MappedRuntimeSpan): string {
  const file = span.attributes['code.file.path'] ?? span.attributes['code.filepath'];
  const line = span.attributes['code.line.number'];
  const method = span.attributes['code.function.name'] ?? span.name;
  return `${typeof file === 'string' ? file : span.serviceName}${typeof line === 'number' ? `:${line}` : ''} · ${String(method)}`;
}
