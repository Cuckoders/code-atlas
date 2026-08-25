import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiagnosticSeverity, ProjectDiagnostic } from '../../shared/graph';

interface DiagnosticsMenuProps {
  diagnostics: ProjectDiagnostic[];
  onSelect: (diagnostic: ProjectDiagnostic) => void;
}

type DiagnosticFilter = 'all' | DiagnosticSeverity;

const FILTERS: Array<{ value: DiagnosticFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'error', label: 'Ошибки' },
  { value: 'warning', label: 'Предупреждения' },
  { value: 'info', label: 'Инфо' },
];

export function DiagnosticsMenu({ diagnostics, onSelect }: DiagnosticsMenuProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<DiagnosticFilter>('all');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const counts = useMemo(() => diagnostics.reduce((result, diagnostic) => {
    result[diagnostic.severity] += 1;
    return result;
  }, { error: 0, warning: 0, info: 0 }), [diagnostics]);
  const filteredDiagnostics = useMemo(() => (
    filter === 'all' ? diagnostics : diagnostics.filter((diagnostic) => diagnostic.severity === filter)
  ), [diagnostics, filter]);
  const leadingSeverity = counts.error ? 'error' : counts.warning ? 'warning' : counts.info ? 'info' : 'clear';

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndRestoreFocus();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeAndRestoreFocus, open]);

  const countFor = (value: DiagnosticFilter) => value === 'all' ? diagnostics.length : counts[value];

  return (
    <div className="diagnostics-menu" ref={rootRef}>
      <button
        type="button"
        className={`diagnostics-trigger diagnostics-trigger--${leadingSeverity}`}
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="diagnostics-popover"
        onClick={() => setOpen((value) => !value)}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M6 1 11.3 10H.7L6 1Zm-.65 3v3.2h1.3V4h-1.3Zm0 4.2v1.3h1.3V8.2h-1.3Z" /></svg>
        Диагностика
        <i>{diagnostics.length}</i>
      </button>

      {open ? (
        <section className="diagnostics-popover" id="diagnostics-popover" role="dialog" aria-label="Диагностика проекта">
          <header>
            <div><span>Проверка архитектуры</span><strong>Диагностика</strong></div>
            <button type="button" aria-label="Закрыть диагностику" onClick={closeAndRestoreFocus}>×</button>
          </header>
          <nav aria-label="Фильтр диагностики">
            {FILTERS.map((item) => (
              <button
                type="button"
                className={filter === item.value ? 'is-active' : ''}
                aria-pressed={filter === item.value}
                disabled={item.value !== 'all' && countFor(item.value) === 0}
                key={item.value}
                onClick={() => setFilter(item.value)}
              >{item.label}<i>{countFor(item.value)}</i></button>
            ))}
          </nav>
          <div className="diagnostics-popover__list">
            {filteredDiagnostics.length ? filteredDiagnostics.map((diagnostic) => (
              <button
                type="button"
                className={`diagnostic diagnostic--${diagnostic.severity}`}
                key={diagnostic.id}
                onClick={() => {
                  closeAndRestoreFocus();
                  onSelect(diagnostic);
                }}
              >
                <i aria-hidden="true" />
                <span><strong>{diagnostic.title}</strong><small>{diagnostic.message}</small></span>
                <b aria-hidden="true">→</b>
              </button>
            )) : (
              <div className="diagnostics-popover__empty">
                <i aria-hidden="true">✓</i>
                <strong>Проблем не найдено</strong>
                <span>Для этого уровня важности замечаний нет.</span>
              </div>
            )}
          </div>
          {filteredDiagnostics.length ? <footer>Выберите проблему, чтобы открыть связанный узел на карте.</footer> : null}
        </section>
      ) : null}
    </div>
  );
}
