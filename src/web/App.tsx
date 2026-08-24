import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import type { AtlasEdge, AtlasNode, NodeKind, ProjectAnalysis } from '../shared/graph';
import { AtlasGraphNode, type AtlasGraphNodeData } from './components/AtlasGraphNode';
import { Inspector } from './components/Inspector';
import { ProjectSidebar } from './components/ProjectSidebar';

const nodeTypes = { atlas: AtlasGraphNode };
const Graph3D = lazy(() => import('./components/Graph3D'));
const ALL_KINDS: NodeKind[] = ['project', 'service', 'database', 'module', 'controller', 'class', 'interface', 'function'];

const COLUMN_BY_KIND: Record<NodeKind, number> = {
  project: 0,
  service: 360,
  database: 360,
  module: 760,
  controller: 760,
  class: 1_160,
  interface: 1_160,
  function: 1_160,
};

const COLOR_BY_KIND: Record<NodeKind, string> = {
  project: '#f4cd72',
  service: '#7ee2c5',
  database: '#f08bb4',
  module: '#74b7ff',
  controller: '#bf91ff',
  class: '#ffac75',
  interface: '#8ea4ff',
  function: '#b7c4d9',
};

export function App() {
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [visibleKinds, setVisibleKinds] = useState<Set<NodeKind>>(() => new Set(ALL_KINDS));
  const [selectedNode, setSelectedNode] = useState<AtlasNode | null>(null);
  const [focusNode, setFocusNode] = useState<AtlasNode | null>(null);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAnalysis = useCallback(async (url: string, init?: RequestInit) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json() as ProjectAnalysis | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Ошибка анализа');
      setAnalysis(payload);
      setSelectedNode(null);
      setFocusNode(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Неизвестная ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAnalysis('/api/demo');
  }, [loadAnalysis]);

  const focusedGraph = useMemo(() => {
    if (!analysis) return { nodes: [] as AtlasNode[], edges: [] as AtlasEdge[] };
    return createFocusedGraph(analysis.nodes, analysis.edges, focusNode?.id);
  }, [analysis, focusNode?.id]);

  const filteredGraph = useMemo(
    () => filterAtlasGraph(focusedGraph.nodes, focusedGraph.edges, visibleKinds, focusNode?.id),
    [focusNode?.id, focusedGraph, visibleKinds],
  );

  const diveableIds = useMemo(() => {
    if (!analysis) return new Set<string>();
    return new Set(analysis.edges.filter((edge) => edge.kind === 'contains').map((edge) => edge.source));
  }, [analysis]);

  const focusTrail = useMemo(() => {
    if (!analysis || !focusNode) return [];
    return buildFocusTrail(analysis.nodes, analysis.edges, focusNode.id);
  }, [analysis, focusNode]);

  const graph = useMemo(
    () => createFlowGraph(filteredGraph.nodes, filteredGraph.edges, deferredSearch),
    [deferredSearch, filteredGraph],
  );

  const handleAnalyze = (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectPath.trim()) return;
    void loadAnalysis('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
  };

  const handleNodeClick = useCallback<NodeMouseHandler>((_event, flowNode) => {
    setSelectedNode((flowNode.data as AtlasGraphNodeData).atlas);
  }, []);

  const handleNodeDoubleClick = useCallback<NodeMouseHandler>((_event, flowNode) => {
    const atlas = (flowNode.data as AtlasGraphNodeData).atlas;
    if (!diveableIds.has(atlas.id)) return;
    setFocusNode(atlas);
    setSelectedNode(null);
  }, [diveableIds]);

  const toggleKind = useCallback((kind: NodeKind) => {
    if (kind === 'project') return;
    setVisibleKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const changeViewMode = useCallback((mode: '2d' | '3d') => {
    startTransition(() => setViewMode(mode));
  }, []);

  const diveIntoSelected = useCallback(() => {
    if (!selectedNode || !diveableIds.has(selectedNode.id)) return;
    startTransition(() => {
      setFocusNode(selectedNode);
      setSelectedNode(null);
    });
  }, [diveableIds, selectedNode]);

  if (!analysis && loading) {
    return <LoadingScreen label="Строим карту демонстрационного проекта" />;
  }

  if (!analysis) {
    return (
      <main className="empty-state">
        <div className="brand-mark">CA</div>
        <h1>Code Atlas</h1>
        <p>{error ?? 'Нет данных для отображения.'}</p>
        <button type="button" onClick={() => void loadAnalysis('/api/demo')}>Повторить</button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">CA</span><strong>Code Atlas</strong><em>alpha</em></div>
        <form className="path-form" onSubmit={handleAnalyze}>
          <span className="path-form__prompt">~/</span>
          <input
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder="Абсолютный путь к проекту"
            aria-label="Путь к проекту"
          />
          <button type="submit" disabled={loading || !projectPath.trim()}>{loading ? 'Анализ…' : 'Построить карту'}</button>
        </form>
        <div className="view-switch" aria-label="Режим карты">
          <button className={viewMode === '2d' ? 'is-active' : ''} type="button" onClick={() => changeViewMode('2d')}>2D</button>
          <button
            className={viewMode === '3d' ? 'is-active' : ''}
            type="button"
            onMouseEnter={() => void import('./components/Graph3D')}
            onFocus={() => void import('./components/Graph3D')}
            onClick={() => changeViewMode('3d')}
          >3D</button>
        </div>
      </header>

      <ProjectSidebar summary={analysis.summary} visibleKinds={visibleKinds} onToggleKind={toggleKind} />

      <section className="canvas-shell">
        <div className="canvas-toolbar">
          <div>
            <span className="pulse" />
            <nav className="focus-breadcrumb" aria-label="Текущий уровень карты">
              <button type="button" onClick={() => setFocusNode(null)}>Архитектурный граф</button>
              {focusTrail.slice(1).map((node, index) => (
                <span key={node.id}>
                  <i>/</i>
                  <button
                    type="button"
                    className={index === focusTrail.length - 2 ? 'is-current' : ''}
                    onClick={() => setFocusNode(node)}
                  >{node.label}</button>
                </span>
              ))}
            </nav>
            <small>{graph.nodes.length} узлов · {graph.edges.length} связей</small>
          </div>
          <label className="search-field">
            <span>⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти модуль, класс, путь…" />
          </label>
        </div>

        {error ? <div className="error-banner">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
        {analysis.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>)}

        {viewMode === '2d' ? (
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={() => setSelectedNode(null)}
            fitView
            fitViewOptions={{ padding: 0.24 }}
            minZoom={0.18}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} color="#29303c" gap={22} size={1.2} />
            <Controls position="bottom-center" showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(node) => COLOR_BY_KIND[(node.data as AtlasGraphNodeData).atlas.kind]}
              maskColor="rgba(6, 8, 13, .72)"
            />
          </ReactFlow>
        ) : (
          <Suspense fallback={<div className="loading-overlay"><span />Загружаем 3D-движок…</div>}>
            <Graph3D
              nodes={filteredGraph.nodes}
              edges={filteredGraph.edges}
              search={deferredSearch}
              selectedId={selectedNode?.id}
              onSelect={setSelectedNode}
            />
          </Suspense>
        )}

        {loading ? <div className="loading-overlay"><span />Анализируем исходники…</div> : null}
      </section>

      <Inspector
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        canDive={Boolean(selectedNode && diveableIds.has(selectedNode.id))}
        onDive={diveIntoSelected}
      />
    </main>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="loading-screen">
      <div className="orbit"><i /><i /><span className="brand-mark">CA</span></div>
      <p>{label}</p>
    </main>
  );
}

function createFlowGraph(
  atlasNodes: AtlasNode[],
  atlasEdges: AtlasEdge[],
  search: string,
): { nodes: Node<AtlasGraphNodeData>[]; edges: Edge[] } {
  const visibleAtlasNodes = atlasNodes;
  const visibleIds = new Set(visibleAtlasNodes.map((node) => node.id));
  const indexByColumn = new Map<number, number>();
  const matchingIds = new Set(
    search
      ? visibleAtlasNodes
          .filter((node) => `${node.label} ${node.path ?? ''} ${node.language ?? ''}`.toLowerCase().includes(search))
          .map((node) => node.id)
      : visibleIds,
  );

  const nodes = visibleAtlasNodes.map((atlas): Node<AtlasGraphNodeData> => {
    const x = COLUMN_BY_KIND[atlas.kind];
    const index = indexByColumn.get(x) ?? 0;
    indexByColumn.set(x, index + 1);
    const spread = x === 0 ? 0 : index * 122;
    return {
      id: atlas.id,
      type: 'atlas',
      position: { x, y: spread },
      data: { atlas, dimmed: Boolean(search) && !matchingIds.has(atlas.id) },
      draggable: true,
      selected: false,
    };
  });

  const edges = atlasEdges
    .filter((item) => visibleIds.has(item.source) && visibleIds.has(item.target))
    .map((item): Edge => ({
      id: item.id,
      source: item.source,
      target: item.target,
      label: item.kind === 'imports' ? undefined : item.kind,
      type: 'smoothstep',
      animated: item.kind === 'imports',
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke: item.kind === 'imports' ? '#416b8c' : item.kind === 'uses' ? '#9b6586' : '#3b4350',
        strokeWidth: item.kind === 'contains' ? 1 : 1.5,
      },
      labelStyle: { fill: '#667083', fontSize: 9 },
      labelBgStyle: { fill: '#0d1017', fillOpacity: 0.8 },
    }));

  return { nodes, edges };
}

function filterAtlasGraph(
  nodes: AtlasNode[],
  edges: AtlasEdge[],
  visibleKinds: Set<NodeKind>,
  preservedNodeId?: string,
): { nodes: AtlasNode[]; edges: AtlasEdge[] } {
  const visibleNodes = nodes.filter((node) => (
    node.kind === 'project' || node.id === preservedNodeId || visibleKinds.has(node.kind)
  ));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  return {
    nodes: visibleNodes,
    edges: edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
  };
}

function createFocusedGraph(
  nodes: AtlasNode[],
  edges: AtlasEdge[],
  focusId?: string,
): { nodes: AtlasNode[]; edges: AtlasEdge[] } {
  if (!focusId) return { nodes, edges };
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'contains') continue;
    const current = children.get(edge.source) ?? [];
    current.push(edge.target);
    children.set(edge.source, current);
  }

  const includedIds = new Set([focusId]);
  const queue = [focusId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const childId of children.get(currentId) ?? []) {
      if (includedIds.has(childId)) continue;
      includedIds.add(childId);
      queue.push(childId);
    }
  }

  const coreIds = new Set(includedIds);
  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    if (coreIds.has(edge.source)) includedIds.add(edge.target);
    if (coreIds.has(edge.target)) includedIds.add(edge.source);
  }

  return {
    nodes: nodes.filter((node) => includedIds.has(node.id)),
    edges: edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target)),
  };
}

function buildFocusTrail(nodes: AtlasNode[], edges: AtlasEdge[], focusId: string): AtlasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentById = new Map(
    edges.filter((edge) => edge.kind === 'contains').map((edge) => [edge.target, edge.source]),
  );
  const trail: AtlasNode[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = focusId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeById.get(currentId);
    if (node) trail.unshift(node);
    currentId = parentById.get(currentId);
  }
  const project = nodes.find((node) => node.kind === 'project');
  if (project && trail[0]?.id !== project.id) trail.unshift(project);
  return trail;
}
