import { useDeferredValue, useMemo, useState } from 'react';
import {
  BLUEPRINT_PRESETS,
  createBlueprintFromPreset,
  type BlueprintPreset,
  type BlueprintPresetCategory,
} from '../../shared/blueprint-presets';
import type { ArchitectureBlueprintDraft, BlueprintNodeKind } from '../../shared/blueprint';

interface BlueprintPresetLibraryProps {
  projectPath: string;
  onClose: () => void;
  onLoad: (blueprint: ArchitectureBlueprintDraft, mode: 'replace' | 'append', preset: BlueprintPreset) => void;
}

const CATEGORY_LABELS: Record<BlueprintPresetCategory | 'all', string> = {
  all: 'Все',
  architecture: 'Архитектура',
  creational: 'Порождающие',
  structural: 'Структурные',
  behavioral: 'Поведенческие',
};

const CATEGORY_ORDER: Array<BlueprintPresetCategory | 'all'> = ['all', 'architecture', 'creational', 'structural', 'behavioral'];

export default function BlueprintPresetLibrary({ projectPath, onClose, onLoad }: BlueprintPresetLibraryProps) {
  const [category, setCategory] = useState<BlueprintPresetCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const visiblePresets = useMemo(() => BLUEPRINT_PRESETS.filter((preset) => {
    if (category !== 'all' && preset.category !== category) return false;
    if (!deferredSearch) return true;
    return `${preset.title} ${preset.description} ${preset.tags.join(' ')}`.toLowerCase().includes(deferredSearch);
  }), [category, deferredSearch]);
  const [selectedId, setSelectedId] = useState(BLUEPRINT_PRESETS[0].id);
  const selected = visiblePresets.find((preset) => preset.id === selectedId) ?? visiblePresets[0];

  const load = (mode: 'replace' | 'append') => {
    if (!selected) return;
    onLoad(createBlueprintFromPreset(selected, projectPath, () => crypto.randomUUID()), mode, selected);
  };

  return (
    <div className="preset-library-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="preset-library" role="dialog" aria-modal="true" aria-labelledby="preset-library-title">
        <header className="preset-library__header">
          <div><span>Blueprint Library</span><h2 id="preset-library-title">Пресеты и паттерны</h2></div>
          <label><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Strategy, DDD, события…" autoFocus /></label>
          <button type="button" className="preset-library__close" onClick={onClose} aria-label="Закрыть библиотеку">×</button>
        </header>
        <nav className="preset-library__tabs" aria-label="Категории пресетов">
          {CATEGORY_ORDER.map((item) => (
            <button key={item} type="button" className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}>{CATEGORY_LABELS[item]}</button>
          ))}
        </nav>
        <div className="preset-library__body">
          <div className="preset-list">
            {visiblePresets.map((preset) => (
              <button key={preset.id} type="button" className={selected?.id === preset.id ? 'is-selected' : ''} onClick={() => setSelectedId(preset.id)}>
                <PresetPreview preset={preset} compact />
                <span><em>{CATEGORY_LABELS[preset.category]}</em><strong>{preset.title}</strong><small>{preset.description}</small><i>{preset.nodes.length} узлов · {preset.edges.length} связей</i></span>
              </button>
            ))}
            {visiblePresets.length === 0 ? <p className="preset-list__empty">По этому запросу пресетов нет.</p> : null}
          </div>
          <article className="preset-detail">
            {selected ? (
              <>
                <div className="preset-detail__preview"><PresetPreview preset={selected} /></div>
                <span>{CATEGORY_LABELS[selected.category]}</span>
                <h3>{selected.title}</h3>
                <p>{selected.description}</p>
                <div className="preset-detail__tags">{selected.tags.map((tag) => <i key={tag}>{tag}</i>)}</div>
                <dl><div><dt>Компоненты</dt><dd>{selected.nodes.length}</dd></div><div><dt>Связи</dt><dd>{selected.edges.length}</dd></div></dl>
                <div className="preset-detail__actions">
                  <button type="button" onClick={() => load('replace')}>Загрузить вместо карты</button>
                  <button type="button" className="is-secondary" onClick={() => load('append')}>Добавить к текущей</button>
                </div>
                <small>Загрузка попадает в историю — действие можно отменить через ⌘Z / Ctrl+Z.</small>
              </>
            ) : <p className="preset-list__empty">Измените запрос или выберите другую категорию.</p>}
          </article>
        </div>
      </section>
    </div>
  );
}

function PresetPreview({ preset, compact = false }: { preset: BlueprintPreset; compact?: boolean }) {
  const bounds = previewBounds(preset);
  const positions = new Map(preset.nodes.map((node) => [node.key, previewPosition(node.position, bounds)]));
  return (
    <svg className={`preset-preview ${compact ? 'is-compact' : ''}`} viewBox="0 0 320 150" aria-label={`Preview: ${preset.title}`}>
      {preset.edges.map((edge, index) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        return source && target ? <line key={`${edge.source}:${edge.target}:${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} /> : null;
      })}
      {preset.nodes.map((node) => {
        const position = positions.get(node.key)!;
        return <g key={node.key} transform={`translate(${position.x} ${position.y})`}><rect x="-22" y="-11" width="44" height="22" rx="5" className={`preset-preview__node preset-preview__node--${node.kind}`} /><text textAnchor="middle" y="3">{previewIcon(node.kind)}</text></g>;
      })}
    </svg>
  );
}

function previewBounds(preset: BlueprintPreset) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of preset.nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x);
    maxY = Math.max(maxY, node.position.y);
  }
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function previewPosition(position: { x: number; y: number }, bounds: ReturnType<typeof previewBounds>) {
  return {
    x: 30 + ((position.x - bounds.minX) / bounds.width) * 260,
    y: 24 + ((position.y - bounds.minY) / bounds.height) * 102,
  };
}

function previewIcon(kind: BlueprintNodeKind): string {
  if (kind === 'interface') return 'I';
  if (kind === 'abstract-class') return 'A';
  if (kind === 'class' || kind === 'component') return 'C';
  if (kind === 'database') return 'DB';
  if (kind === 'queue') return 'Q';
  if (kind === 'service') return 'S';
  if (kind === 'gateway') return 'G';
  return '•';
}
