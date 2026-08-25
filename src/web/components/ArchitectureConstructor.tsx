import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  BLUEPRINT_EDGE_KINDS,
  BLUEPRINT_NODE_KINDS,
  BLUEPRINT_NODE_STATUSES,
  BLUEPRINT_VERSION,
  MAX_BLUEPRINT_EDGES,
  MAX_BLUEPRINT_NODES,
  type ArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
  type BlueprintEdge,
  type BlueprintEdgeKind,
  type BlueprintNode,
  type BlueprintNodeKind,
  type BlueprintNodeStatus,
} from '../../shared/blueprint';
import type { AtlasNode, NodeKind, ProjectAnalysis } from '../../shared/graph';
import type { BlueprintPreset } from '../../shared/blueprint-presets';
import { apiFetch } from '../desktop';
import {
  calculateBlueprintImpact,
  findBlueprintMatchSuggestions,
  type BlueprintImpact,
  type BlueprintMatchSuggestion,
} from '../blueprint-insights';
import { layoutAtlasGraph } from '../graph-layout';
import {
  BlueprintGraphNode,
  type BlueprintDriftState,
  type BlueprintGraphNodeData,
} from './BlueprintGraphNode';

const nodeTypes = { blueprint: BlueprintGraphNode };
const BlueprintPresetLibrary = lazy(() => import('./BlueprintPresetLibrary'));
const PALETTE_KINDS: BlueprintNodeKind[] = [
  'system', 'service', 'frontend', 'gateway', 'controller', 'module',
  'component', 'class', 'abstract-class', 'interface', 'database', 'cache', 'queue', 'external',
];

const NODE_LABELS: Record<BlueprintNodeKind, string> = {
  system: 'Система',
  service: 'Сервис',
  frontend: 'Frontend',
  gateway: 'Gateway',
  controller: 'Контроллер',
  module: 'Модуль',
  component: 'Компонент',
  class: 'Класс',
  'abstract-class': 'Абстрактный класс',
  interface: 'Интерфейс',
  database: 'База данных',
  cache: 'Кэш',
  queue: 'Очередь',
  external: 'Внешняя система',
};

const EDGE_LABELS: Record<BlueprintEdgeKind, string> = {
  http: 'HTTP', grpc: 'gRPC', event: 'Событие', reads: 'Читает', writes: 'Пишет', depends: 'Зависит',
  implements: 'Реализует', extends: 'Наследует', creates: 'Создаёт', calls: 'Вызывает',
};

const STATUS_LABELS: Record<BlueprintNodeStatus, string> = {
  planned: 'Запланирован', approved: 'Согласован', implemented: 'Реализован',
};

type Selection = { type: 'node' | 'edge' | 'actual'; id: string } | null;
type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

interface ArchitectureConstructorProps {
  analysis: ProjectAnalysis;
}

export default function ArchitectureConstructor({ analysis }: ArchitectureConstructorProps) {
  const emptyDocument = useMemo<ArchitectureBlueprintDraft>(() => ({
    version: BLUEPRINT_VERSION,
    projectPath: analysis.summary.rootPath,
    nodes: [],
    edges: [],
  }), [analysis.summary.rootPath]);
  const [document, setDocument] = useState<ArchitectureBlueprintDraft>(emptyDocument);
  const documentRef = useRef(document);
  const history = useRef<{ past: ArchitectureBlueprintDraft[]; future: ArchitectureBlueprintDraft[] }>({ past: [], future: [] });
  const dragStart = useRef<ArchitectureBlueprintDraft | null>(null);
  const flowInstance = useRef<ReactFlowInstance<Node<BlueprintGraphNodeData>, Edge> | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [showActual, setShowActual] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [message, setMessage] = useState('Загружаем blueprint…');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [presetLibraryOpen, setPresetLibraryOpen] = useState(false);
  const [, setHistoryVersion] = useState(0);

  const replaceDocument = useCallback((next: ArchitectureBlueprintDraft, recordHistory = true) => {
    if (recordHistory) {
      history.current.past = [...history.current.past.slice(-49), documentRef.current];
      history.current.future = [];
    }
    documentRef.current = next;
    setDocument(next);
    setDirty(true);
    setSaveState('idle');
    setHistoryVersion((value) => value + 1);
  }, []);

  const commit = useCallback((update: (current: ArchitectureBlueprintDraft) => ArchitectureBlueprintDraft) => {
    const next = update(documentRef.current);
    if (next !== documentRef.current) replaceDocument(next);
  }, [replaceDocument]);

  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.unshift(documentRef.current);
    documentRef.current = previous;
    setDocument(previous);
    setDirty(true);
    setSaveState('idle');
    setSelection(null);
    setHistoryVersion((value) => value + 1);
  }, []);

  const redo = useCallback(() => {
    const next = history.current.future.shift();
    if (!next) return;
    history.current.past.push(documentRef.current);
    documentRef.current = next;
    setDocument(next);
    setDirty(true);
    setSaveState('idle');
    setSelection(null);
    setHistoryVersion((value) => value + 1);
  }, []);

  const deleteSelection = useCallback(() => {
    if (!selection || selection.type === 'actual') return;
    commit((current) => selection.type === 'node'
      ? {
          ...current,
          nodes: current.nodes.filter((node) => node.id !== selection.id),
          edges: current.edges.filter((edge) => edge.source !== selection.id && edge.target !== selection.id),
        }
      : { ...current, edges: current.edges.filter((edge) => edge.id !== selection.id) });
    setSelection(null);
  }, [commit, selection]);

  useEffect(() => {
    const controller = new AbortController();
    setSaveState('loading');
    void apiFetch(`/api/blueprints?projectPath=${encodeURIComponent(analysis.summary.rootPath)}`, {
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json() as ArchitectureBlueprint | { error: string } | null;
      if (payload === null) {
        documentRef.current = emptyDocument;
        setDocument(emptyDocument);
        setSaveState('idle');
        setMessage('Blueprint ещё не создан. Перетащите компонент или импортируйте факт.');
        return;
      }
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось загрузить blueprint.');
      const draft: ArchitectureBlueprintDraft = {
        version: payload.version,
        projectPath: payload.projectPath,
        nodes: payload.nodes,
        edges: payload.edges,
      };
      documentRef.current = draft;
      setDocument(draft);
      setUpdatedAt(payload.updatedAt);
      setDirty(false);
      setSaveState('saved');
      setMessage('Blueprint загружен.');
    }).catch((loadError: unknown) => {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setSaveState('error');
      setMessage(loadError instanceof Error ? loadError.message : 'Не удалось загрузить blueprint.');
    });
    return () => controller.abort();
  }, [analysis.summary.rootPath, emptyDocument]);

  const save = useCallback(async () => {
    const snapshot = documentRef.current;
    setSaveState('saving');
    setMessage('Сохраняем blueprint…');
    try {
      const response = await apiFetch('/api/blueprints', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      const payload = await response.json() as ArchitectureBlueprint | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось сохранить blueprint.');
      setUpdatedAt(payload.updatedAt);
      if (documentRef.current === snapshot) setDirty(false);
      setSaveState('saved');
      setMessage('Blueprint сохранён локально.');
    } catch (saveError) {
      setSaveState('error');
      setMessage(saveError instanceof Error ? saveError.message : 'Не удалось сохранить blueprint.');
    }
  }, []);

  const addNode = useCallback((kind: BlueprintNodeKind, position?: { x: number; y: number }) => {
    const bounds = canvas.current?.getBoundingClientRect();
    const fallbackScreen = bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : { x: 480, y: 320 };
    const nextPosition = position ?? flowInstance.current?.screenToFlowPosition(fallbackScreen) ?? { x: 120, y: 120 };
    const node: BlueprintNode = {
      id: crypto.randomUUID(),
      label: NODE_LABELS[kind],
      kind,
      status: 'planned',
      position: nextPosition,
    };
    commit((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelection({ type: 'node', id: node.id });
  }, [commit]);

  const importActual = useCallback(() => {
    const atlasNodes = analysis.nodes.slice(0, MAX_BLUEPRINT_NODES);
    const atlasIds = new Set(atlasNodes.map((node) => node.id));
    const atlasEdges = analysis.edges
      .filter((edge) => atlasIds.has(edge.source) && atlasIds.has(edge.target))
      .slice(0, MAX_BLUEPRINT_EDGES);
    const layout = layoutAtlasGraph(atlasNodes, atlasEdges, 'layers');
    const idByActual = new Map(atlasNodes.map((node) => [node.id, crypto.randomUUID()]));
    const nodes: BlueprintNode[] = atlasNodes.map((node) => ({
      id: idByActual.get(node.id)!,
      label: node.label,
      kind: blueprintKindForAtlasNode(node),
      position: layout.positions.get(node.id) ?? { x: 0, y: 0 },
      status: 'implemented',
      ...(node.language ? { language: node.language } : {}),
      ...(node.subtitle ? { technology: node.subtitle } : {}),
      actualNodeId: node.id,
    }));
    const edges: BlueprintEdge[] = atlasEdges.map((edge) => ({
      id: crypto.randomUUID(),
      source: idByActual.get(edge.source)!,
      target: idByActual.get(edge.target)!,
      kind: edge.kind === 'uses' ? 'reads' : 'depends',
      ...(edge.label ? { label: edge.label } : {}),
    }));
    replaceDocument({ version: BLUEPRINT_VERSION, projectPath: analysis.summary.rootPath, nodes, edges });
    setShowActual(false);
    setSelection(null);
    window.requestAnimationFrame(() => void flowInstance.current?.fitView({ padding: 0.2, duration: 300 }));
  }, [analysis, replaceDocument]);

  const loadPreset = useCallback((
    presetDocument: ArchitectureBlueprintDraft,
    mode: 'replace' | 'append',
    preset: BlueprintPreset,
  ) => {
    if (mode === 'replace') {
      replaceDocument(presetDocument);
      setShowActual(false);
    } else {
      const current = documentRef.current;
      if (current.nodes.length + presetDocument.nodes.length > MAX_BLUEPRINT_NODES
        || current.edges.length + presetDocument.edges.length > MAX_BLUEPRINT_EDGES) {
        setSaveState('error');
        setMessage('Пресет не помещается в лимиты blueprint.');
        return;
      }
      const currentMaxX = current.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x), -320);
      const presetMinX = presetDocument.nodes.reduce((minimum, node) => Math.min(minimum, node.position.x), 0);
      const offsetX = currentMaxX + 340 - presetMinX;
      replaceDocument({
        ...current,
        nodes: [...current.nodes, ...presetDocument.nodes.map((node) => ({
          ...node,
          position: { x: node.position.x + offsetX, y: node.position.y },
        }))],
        edges: [...current.edges, ...presetDocument.edges],
      });
    }
    setPresetLibraryOpen(false);
    setSelection(null);
    setMessage(`Пресет «${preset.title}» ${mode === 'replace' ? 'загружен' : 'добавлен'}.`);
    window.requestAnimationFrame(() => void flowInstance.current?.fitView({ padding: 0.2, duration: 320 }));
  }, [replaceDocument]);

  const matchedActualIds = useMemo(() => new Set(document.nodes.flatMap((node) => node.actualNodeId ? [node.actualNodeId] : [])), [document.nodes]);
  const actualNodeIds = useMemo(() => new Set(analysis.nodes.map((node) => node.id)), [analysis.nodes]);
  const visibleActualNodes = useMemo(() => analysis.nodes.slice(0, MAX_BLUEPRINT_NODES), [analysis.nodes]);
  const visibleActualIds = useMemo(() => new Set(visibleActualNodes.map((node) => node.id)), [visibleActualNodes]);
  const visibleActualEdges = useMemo(() => analysis.edges
    .filter((edge) => visibleActualIds.has(edge.source) && visibleActualIds.has(edge.target))
    .slice(0, MAX_BLUEPRINT_EDGES), [analysis.edges, visibleActualIds]);
  const visibleActualOnly = useMemo(
    () => visibleActualNodes.filter((node) => !matchedActualIds.has(node.id)),
    [matchedActualIds, visibleActualNodes],
  );
  const actualLayout = useMemo(
    () => layoutAtlasGraph(visibleActualNodes, visibleActualEdges, 'layers'),
    [visibleActualEdges, visibleActualNodes],
  );
  const drift = useMemo(() => ({
    matched: document.nodes.filter((node) => node.actualNodeId && actualNodeIds.has(node.actualNodeId)).length,
    planned: document.nodes.filter((node) => !node.actualNodeId || !actualNodeIds.has(node.actualNodeId)).length,
    actual: analysis.nodes.reduce((count, node) => count + (matchedActualIds.has(node.id) ? 0 : 1), 0),
  }), [actualNodeIds, analysis.nodes, document.nodes, matchedActualIds]);

  const flowNodes = useMemo<Node<BlueprintGraphNodeData>[]>(() => {
    const planned = document.nodes.map((node): Node<BlueprintGraphNodeData> => ({
      id: node.id,
      type: 'blueprint',
      position: node.position,
      selected: selection?.type === 'node' && selection.id === node.id,
      data: {
        label: node.label,
        kind: node.kind,
        status: node.status,
        subtitle: node.technology || node.language,
        drift: node.actualNodeId && actualNodeIds.has(node.actualNodeId) ? 'matched' : 'planned-only',
      },
    }));
    if (!showActual) return planned;
    const ghosts = visibleActualOnly.map((node): Node<BlueprintGraphNodeData> => ({
      id: `actual:${node.id}`,
      type: 'blueprint',
      position: actualLayout.positions.get(node.id) ?? { x: 0, y: 0 },
      selected: selection?.type === 'actual' && selection.id === node.id,
      draggable: false,
      connectable: false,
      data: {
        label: node.label,
        kind: blueprintKindForAtlasNode(node),
        status: 'implemented',
        subtitle: node.subtitle || node.language,
        drift: 'actual-only',
        readOnly: true,
      },
    }));
    return [...ghosts, ...planned];
  }, [actualLayout.positions, actualNodeIds, document.nodes, selection, showActual, visibleActualOnly]);

  const flowEdges = useMemo<Edge[]>(() => {
    const planned = document.edges.map((edge): Edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || EDGE_LABELS[edge.kind],
      type: 'smoothstep',
      selected: selection?.type === 'edge' && selection.id === edge.id,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke: edgeColor(edge.kind),
        strokeWidth: 1.7,
        strokeDasharray: edge.kind === 'implements' || edge.kind === 'extends' ? '5 3' : undefined,
      },
      labelStyle: { fill: '#718092', fontSize: 8 },
      labelBgStyle: { fill: '#0b0e14', fillOpacity: 0.86 },
    }));
    if (!showActual) return planned;
    const actualOnlyIds = new Set(visibleActualOnly.map((node) => node.id));
    const ghosts = visibleActualEdges
      .filter((edge) => actualOnlyIds.has(edge.source) && actualOnlyIds.has(edge.target))
      .map((edge): Edge => ({
        id: `actual:${edge.id}`,
        source: `actual:${edge.source}`,
        target: `actual:${edge.target}`,
        type: 'smoothstep',
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: '#7a4b54', strokeWidth: 1, strokeDasharray: '4 5', opacity: 0.46 },
      }));
    return [...ghosts, ...planned];
  }, [document.edges, selection, showActual, visibleActualEdges, visibleActualOnly]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const positions = new Map<string, { x: number; y: number }>();
    for (const change of changes) {
      if (change.type === 'position' && change.position && !change.id.startsWith('actual:')) positions.set(change.id, change.position);
    }
    if (positions.size === 0) return;
    const next = {
      ...documentRef.current,
      nodes: documentRef.current.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
    };
    documentRef.current = next;
    setDocument(next);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target
      || connection.source.startsWith('actual:') || connection.target.startsWith('actual:')) return;
    const edge: BlueprintEdge = {
      id: crypto.randomUUID(),
      source: connection.source,
      target: connection.target,
      kind: 'depends',
    };
    commit((current) => ({ ...current, edges: [...current.edges, edge] }));
    setSelection({ type: 'edge', id: edge.id });
  }, [commit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (!editing && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelection();
      } else if (!editing && event.key === 'Escape') {
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection, redo, undo]);

  const selectedNode = selection?.type === 'node' ? document.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.type === 'edge' ? document.edges.find((edge) => edge.id === selection.id) : undefined;
  const selectedActual = selection?.type === 'actual' ? analysis.nodes.find((node) => node.id === selection.id) : undefined;
  const matchSuggestions = useMemo(() => selectedNode && !selectedNode.actualNodeId
    ? findBlueprintMatchSuggestions(selectedNode, analysis.nodes, matchedActualIds)
    : [], [analysis.nodes, matchedActualIds, selectedNode]);
  const impact = useMemo(() => selectedNode
    ? calculateBlueprintImpact(selectedNode.id, document.nodes, document.edges)
    : null, [document.edges, document.nodes, selectedNode]);

  return (
    <div className="architecture-constructor">
      <div className="blueprint-actionbar">
        <div className="blueprint-history">
          <button type="button" className="blueprint-history-button" disabled={history.current.past.length === 0} onClick={undo} title="Отменить (⌘Z)" aria-label="Отменить изменение">↶</button>
          <button type="button" className="blueprint-history-button" disabled={history.current.future.length === 0} onClick={redo} title="Повторить (⇧⌘Z)" aria-label="Повторить изменение">↷</button>
          <button
            type="button"
            className="blueprint-presets"
            onMouseEnter={() => void import('./BlueprintPresetLibrary')}
            onFocus={() => void import('./BlueprintPresetLibrary')}
            onClick={() => setPresetLibraryOpen(true)}
          ><span aria-hidden="true">✦</span><strong>Паттерны & пресеты</strong></button>
          <button type="button" className="blueprint-import" onClick={importActual}>Импортировать факт</button>
        </div>
        <div className="blueprint-drift" aria-label="Архитектурный drift">
          <span className="is-matched">● {drift.matched} совпадает</span>
          <span className="is-planned">● {drift.planned} только план</span>
          <span className="is-actual">● {drift.actual} только факт</span>
        </div>
        <div className="blueprint-save">
          <span className={`blueprint-save__status is-${saveState}`}>{message}{updatedAt ? ` · ${formatTime(updatedAt)}` : ''}</span>
          <label className="blueprint-fact-toggle" title="Показать фактическую карту проекта как фоновый слой">
            <input type="checkbox" checked={showActual} onChange={(event) => setShowActual(event.target.checked)} />
            <span>Фоновый факт</span>
          </label>
          <button type="button" disabled={!dirty || saveState === 'saving' || saveState === 'loading'} onClick={() => void save()}>
            {saveState === 'saving' ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>

      <aside className="blueprint-palette">
        <header><span>Компоненты</span><small>Перетащите на карту</small></header>
        <div>
          {PALETTE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/code-atlas-blueprint-kind', kind);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => addNode(kind)}
            >
              <i>{nodeIcon(kind)}</i><span>{NODE_LABELS[kind]}</span><em>＋</em>
            </button>
          ))}
        </div>
        <p>Соедините узлы, потянув за точку справа к точке слева.</p>
      </aside>

      <div
        className="blueprint-canvas"
        ref={canvas}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          event.preventDefault();
          const kind = event.dataTransfer.getData('application/code-atlas-blueprint-kind') as BlueprintNodeKind;
          if (!BLUEPRINT_NODE_KINDS.includes(kind)) return;
          const position = flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          addNode(kind, position);
        }}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onInit={(instance) => { flowInstance.current = instance; }}
          onNodesChange={onNodesChange}
          onNodeDragStart={() => { dragStart.current = documentRef.current; }}
          onNodeDragStop={() => {
            if (!dragStart.current || dragStart.current === documentRef.current) return;
            history.current.past = [...history.current.past.slice(-49), dragStart.current];
            history.current.future = [];
            dragStart.current = null;
            setDirty(true);
            setSaveState('idle');
            setHistoryVersion((value) => value + 1);
          }}
          onConnect={onConnect}
          onNodeClick={(_event, node) => setSelection(node.id.startsWith('actual:')
            ? { type: 'actual', id: node.id.slice('actual:'.length) }
            : { type: 'node', id: node.id })}
          onEdgeClick={(_event, edge) => {
            if (!edge.id.startsWith('actual:')) setSelection({ type: 'edge', id: edge.id });
          }}
          onPaneClick={() => setSelection(null)}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.22 }}
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} color="#29303c" gap={22} size={1.2} />
          <Controls className="blueprint-map-controls" position="bottom-right" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            maskColor="rgba(6, 8, 13, .72)"
            nodeColor={(node) => driftColor((node.data as BlueprintGraphNodeData).drift)}
          />
        </ReactFlow>
        {document.nodes.length === 0 && !showActual ? (
          <div className="blueprint-empty"><strong>Начните с системы или сервиса</strong><span>Перетащите компонент из палитры на карту.</span></div>
        ) : null}
      </div>

      <aside className="blueprint-inspector">
        {selectedNode && impact ? (
          <NodeEditor
            key={selectedNode.id}
            node={selectedNode}
            suggestions={matchSuggestions}
            impact={impact}
            onSelectNode={(nodeId) => setSelection({ type: 'node', id: nodeId })}
            onApply={(next) => commit((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === next.id ? next : node) }))}
            onDelete={deleteSelection}
          />
        ) : null}
        {selectedEdge ? <EdgeEditor key={selectedEdge.id} edge={selectedEdge} onApply={(next) => commit((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === next.id ? next : edge) }))} onDelete={deleteSelection} /> : null}
        {selectedActual ? <ActualInspector node={selectedActual} /> : null}
        {!selectedNode && !selectedEdge && !selectedActual ? <BlueprintHelp drift={drift} /> : null}
      </aside>
      {presetLibraryOpen ? (
        <Suspense fallback={<div className="preset-library-loading">Загружаем библиотеку паттернов…</div>}>
          <BlueprintPresetLibrary projectPath={analysis.summary.rootPath} onClose={() => setPresetLibraryOpen(false)} onLoad={loadPreset} />
        </Suspense>
      ) : null}
    </div>
  );
}

function ImpactCard({ impact, onSelectNode }: { impact: BlueprintImpact; onSelectNode: (nodeId: string) => void }) {
  return (
    <section className={`blueprint-impact blueprint-impact--${impact.level}`}>
      <header><span>Blast radius</span><strong>{impact.level === 'high' ? 'Высокий' : impact.level === 'medium' ? 'Средний' : 'Низкий'}</strong></header>
      <div><span><strong>{impact.directDependencies.length}</strong> зависимостей</span><span><strong>{impact.directDependents.length}</strong> прямых потребителей</span><span><strong>{impact.affected.length}</strong> затронуто всего</span></div>
      {impact.affected.length > 0 ? (
        <ul>{impact.affected.slice(0, 6).map((affected) => <li key={affected.id}><button type="button" onClick={() => onSelectNode(affected.id)}>{affected.label}<i>→</i></button></li>)}</ul>
      ) : <p>Изменение этого узла пока не затрагивает другие компоненты.</p>}
    </section>
  );
}

function NodeEditor({
  node,
  suggestions,
  impact,
  onApply,
  onDelete,
  onSelectNode,
}: {
  node: BlueprintNode;
  suggestions: BlueprintMatchSuggestion[];
  impact: BlueprintImpact;
  onApply: (node: BlueprintNode) => void;
  onDelete: () => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const [draft, setDraft] = useState(node);
  const applyActualLink = (actualNodeId?: string) => {
    const next = cleanNode({ ...draft, actualNodeId });
    setDraft(next);
    onApply(next);
  };
  return (
    <form className="blueprint-editor" onSubmit={(event) => {
      event.preventDefault();
      const label = draft.label.trim();
      if (!label) return;
      onApply(cleanNode({ ...draft, label }));
    }}>
      <header><span>Узел blueprint</span><strong>{nodeIcon(draft.kind)} {draft.label}</strong></header>
      <label><span>Название</span><input maxLength={128} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      <label><span>Тип</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as BlueprintNodeKind })}>{BLUEPRINT_NODE_KINDS.map((kind) => <option key={kind} value={kind}>{NODE_LABELS[kind]}</option>)}</select></label>
      <label><span>Статус</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as BlueprintNodeStatus })}>{BLUEPRINT_NODE_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
      <label><span>Технология</span><input maxLength={128} value={draft.technology ?? ''} onChange={(event) => setDraft({ ...draft, technology: event.target.value })} placeholder="Fastify, Spring, Kafka…" /></label>
      <label><span>Язык</span><input maxLength={128} value={draft.language ?? ''} onChange={(event) => setDraft({ ...draft, language: event.target.value })} placeholder="TypeScript, Kotlin…" /></label>
      <label><span>Владелец</span><input maxLength={128} value={draft.owner ?? ''} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} placeholder="Команда или человек" /></label>
      {draft.actualNodeId ? (
        <div className="blueprint-linked"><span>Связан с фактом</span><code>{draft.actualNodeId}</code><button type="button" onClick={() => applyActualLink(undefined)}>Отвязать</button></div>
      ) : suggestions.length > 0 ? (
        <div className="blueprint-match-suggestions">
          <span>Возможные совпадения с кодом</span>
          {suggestions.map((suggestion) => (
            <button key={suggestion.node.id} type="button" onClick={() => applyActualLink(suggestion.node.id)}>
              <i>{suggestion.score}%</i><strong>{suggestion.node.label}</strong><small>{suggestion.reasons.join(' · ')}</small>
            </button>
          ))}
        </div>
      ) : null}
      <ImpactCard impact={impact} onSelectNode={onSelectNode} />
      <div className="blueprint-editor__actions"><button type="submit">Применить</button><button type="button" className="is-danger" onClick={onDelete}>Удалить</button></div>
    </form>
  );
}

function EdgeEditor({ edge, onApply, onDelete }: { edge: BlueprintEdge; onApply: (edge: BlueprintEdge) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(edge);
  return (
    <form className="blueprint-editor" onSubmit={(event) => { event.preventDefault(); onApply(cleanEdge(draft)); }}>
      <header><span>Связь blueprint</span><strong>→ {EDGE_LABELS[draft.kind]}</strong></header>
      <label><span>Тип связи</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as BlueprintEdgeKind })}>{BLUEPRINT_EDGE_KINDS.map((kind) => <option key={kind} value={kind}>{EDGE_LABELS[kind]}</option>)}</select></label>
      <label><span>Подпись</span><input maxLength={128} value={draft.label ?? ''} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Например, /api/orders" /></label>
      <div className="blueprint-editor__actions"><button type="submit">Применить</button><button type="button" className="is-danger" onClick={onDelete}>Удалить</button></div>
    </form>
  );
}

function ActualInspector({ node }: { node: AtlasNode }) {
  return <div className="blueprint-editor blueprint-actual-inspector"><header><span>Фактический узел · только чтение</span><strong>{node.label}</strong></header><dl><div><dt>Тип</dt><dd>{node.kind}</dd></div>{node.language ? <div><dt>Язык</dt><dd>{node.language}</dd></div> : null}{node.path ? <div><dt>Путь</dt><dd>{node.path}</dd></div> : null}</dl><p>Импортируйте фактическую карту, чтобы превратить этот узел в редактируемую часть blueprint.</p></div>;
}

function BlueprintHelp({ drift }: { drift: { matched: number; planned: number; actual: number } }) {
  return <div className="blueprint-help"><span>Architecture Blueprint</span><h2>Спроектируйте целевую архитектуру</h2><p>Добавляйте компоненты, связывайте их и сравнивайте план с кодом, который Code Atlas уже обнаружил.</p><ol><li><i>1</i>Перетащите компоненты</li><li><i>2</i>Соедините точки на узлах</li><li><i>3</i>Настройте свойства справа</li><li><i>4</i>Сохраните blueprint</li></ol><div><strong>{drift.planned}</strong><span>ещё нет в коде</span><strong>{drift.actual}</strong><span>не описано в плане</span></div><small>⌘Z — отмена · Delete — удалить · Esc — снять выбор</small></div>;
}

function cleanNode(node: BlueprintNode): BlueprintNode {
  return {
    ...node,
    label: node.label.trim(),
    ...(node.technology?.trim() ? { technology: node.technology.trim() } : { technology: undefined }),
    ...(node.language?.trim() ? { language: node.language.trim() } : { language: undefined }),
    ...(node.owner?.trim() ? { owner: node.owner.trim() } : { owner: undefined }),
  };
}

function cleanEdge(edge: BlueprintEdge): BlueprintEdge {
  return { ...edge, ...(edge.label?.trim() ? { label: edge.label.trim() } : { label: undefined }) };
}

function blueprintKindForAtlasNode(node: AtlasNode): BlueprintNodeKind {
  if (node.kind === 'project') return 'system';
  if (node.kind === 'service') return 'service';
  if (node.kind === 'database') return /redis|cache/i.test(node.label) ? 'cache' : 'database';
  if (node.kind === 'controller') return 'controller';
  if (node.kind === 'module') return 'module';
  if (node.kind === 'class') return 'class';
  if (node.kind === 'interface') return 'interface';
  return 'component';
}

function nodeIcon(kind: BlueprintNodeKind): string {
  const icons: Record<BlueprintNodeKind, string> = { system: '◇', service: '⬡', frontend: '▱', gateway: '↔', controller: '⌁', module: '▤', component: 'C', class: 'C', 'abstract-class': 'A', interface: 'I', database: '◉', cache: '◆', queue: '≋', external: '↗' };
  return icons[kind];
}

function driftColor(state: BlueprintDriftState): string {
  if (state === 'matched') return '#62c8a9';
  if (state === 'planned-only') return '#74b7ff';
  return '#c66376';
}

function edgeColor(kind: BlueprintEdgeKind): string {
  if (kind === 'event') return '#bf91ff';
  if (kind === 'writes') return '#f08bb4';
  if (kind === 'implements') return '#8ea4ff';
  if (kind === 'extends') return '#f4cd72';
  if (kind === 'creates') return '#ffac75';
  if (kind === 'calls') return '#7ec8f7';
  return '#5b9f8d';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
