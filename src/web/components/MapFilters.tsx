import { useEffect, useRef, useState } from 'react';
import type { NodeKind } from '../../shared/graph';

interface MapFiltersProps {
  visibleKinds: Set<NodeKind>;
  onChange: (kinds: Set<NodeKind>) => void;
}

const FILTERS: Array<{ kind: NodeKind; label: string }> = [
  { kind: 'service', label: 'Сервисы' },
  { kind: 'database', label: 'Базы данных' },
  { kind: 'module', label: 'Модули' },
  { kind: 'controller', label: 'Контроллеры' },
  { kind: 'class', label: 'Классы' },
  { kind: 'interface', label: 'Интерфейсы' },
  { kind: 'function', label: 'Функции' },
];

export function MapFilters({ visibleKinds, onChange }: MapFiltersProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCount = FILTERS.reduce((count, filter) => count + (visibleKinds.has(filter.kind) ? 1 : 0), 0);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggleKind = (kind: NodeKind) => {
    const next = new Set(visibleKinds);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    onChange(next);
  };

  const showAll = () => onChange(new Set<NodeKind>(['project', ...FILTERS.map((filter) => filter.kind)]));
  const hideAll = () => onChange(new Set<NodeKind>(['project']));

  return (
    <div className="map-filter-control" ref={rootRef}>
      <button
        type="button"
        className={`map-filter-trigger ${activeCount < FILTERS.length ? 'has-filter' : ''}`}
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="map-filter-popover"
        aria-label={`Фильтры карты: ${activeCount} из ${FILTERS.length}`}
        title="Фильтры карты"
        onClick={() => setOpen((value) => !value)}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M1 2h10L7.1 6.4v3.1L4.9 11V6.4L1 2Z" /></svg>
        <b>Фильтры</b>
        <i>{activeCount}/{FILTERS.length}</i>
      </button>

      {open ? (
        <section className="map-filter-popover" id="map-filter-popover" role="dialog" aria-label="Фильтры слоёв карты">
          <header><div><span>Отображение карты</span><strong>Слои</strong></div><button type="button" aria-label="Закрыть фильтры" onClick={() => {
            setOpen(false);
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}>×</button></header>
          <div className="map-filter-options">
            {FILTERS.map((filter) => (
              <label key={filter.kind}>
                <input type="checkbox" checked={visibleKinds.has(filter.kind)} onChange={() => toggleKind(filter.kind)} />
                <span className={`kind-dot kind-dot--${filter.kind}`} aria-hidden="true" />
                <strong>{filter.label}</strong>
                <i aria-hidden="true">✓</i>
              </label>
            ))}
          </div>
          <footer>
            <span>Показано {activeCount} из {FILTERS.length}</span>
            <div><button type="button" onClick={hideAll}>Скрыть все</button><button type="button" onClick={showAll} disabled={activeCount === FILTERS.length}>Сбросить</button></div>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
