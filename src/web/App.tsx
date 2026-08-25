import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import type {
  AnalysisJob,
  AnalysisJobPriority,
  AnalysisProgress,
  AnalysisJobStatus,
  AnalysisSnapshotSummary,
  AtlasEdge,
  AtlasNode,
  NodeKind,
  ProjectAnalysis,
  ProjectDiagnostic,
  StoredAnalysisSnapshot,
} from '../shared/graph';
import type { ArchitectureBlueprintDraft } from '../shared/blueprint';
import type { RequestTrace } from '../shared/request-trace';
import type { SourceEditor } from '../shared/source-editor';
import { AtlasGraphNode, type AtlasGraphNodeData } from './components/AtlasGraphNode';
import { DiagnosticsMenu } from './components/DiagnosticsMenu';
import { GraphZoneNode, type GraphZoneNodeData } from './components/GraphZoneNode';
import { Inspector } from './components/Inspector';
import { MapFilters } from './components/MapFilters';
import { ProjectSidebar } from './components/ProjectSidebar';
import { RequestTraceEdge, type RequestTraceEdgeData } from './components/RequestTraceEdge';
import { RequestTracePanel } from './components/RequestTracePanel';
import { apiFetch, chooseProjectDirectory, hasNativeDirectoryPicker } from './desktop';
import { layoutAtlasGraph, type GraphLayoutMode } from './graph-layout';
import { openNodeInEditor, sourceLocationForNode } from './source-editor';
import type { TracePlaybackOptions } from './trace-playback';

const nodeTypes = { atlas: AtlasGraphNode, serviceZone: GraphZoneNode, layerZone: GraphZoneNode };
const edgeTypes = { requestTrace: RequestTraceEdge };
const Graph3D = lazy(() => import('./components/Graph3D'));
const ArchitectureConstructor = lazy(() => import('./components/ArchitectureConstructor'));
const BlueprintMapView = lazy(() => import('./components/BlueprintMapView'));
const RuntimeTracePanel = lazy(() => import('./components/RuntimeTracePanel'));
const ALL_KINDS: NodeKind[] = ['project', 'service', 'database', 'module', 'controller', 'class', 'interface', 'function'];
const SIDEBAR_STORAGE_KEY = 'code-atlas:ui:sidebar:v1';
const SOURCE_EDITOR_STORAGE_KEY = 'code-atlas:source-editor:v1';

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

type RightToolPanel = 'request' | 'runtime' | null;
type BlueprintMapSelection = { id: string | null; name: string; document: ArchitectureBlueprintDraft };

export function App() {
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [visibleKinds, setVisibleKinds] = useState<Set<NodeKind>>(() => new Set(ALL_KINDS));
  const [selectedNode, setSelectedNode] = useState<AtlasNode | null>(null);
  const [focusNode, setFocusNode] = useState<AtlasNode | null>(null);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const [workspaceMode, setWorkspaceMode] = useState<'map' | 'constructor'>('map');
  const [mapBlueprint, setMapBlueprint] = useState<BlueprintMapSelection | null>(null);
  const [mapSource, setMapSource] = useState<'analysis' | 'blueprint'>('analysis');
  const [sidebarOpen, setSidebarOpen] = useState(() => readSidebarPreference());
  const [sourceEditor, setSourceEditor] = useState<SourceEditor>(() => readSourceEditorPreference());
  const [loading, setLoading] = useState(true);
  const [jobStatus, setJobStatus] = useState<AnalysisJobStatus | null>(null);
  const [jobProgress, setJobProgress] = useState<AnalysisProgress | null>(null);
  const [analysisPriority, setAnalysisPriority] = useState<AnalysisJobPriority>('normal');
  const [snapshots, setSnapshots] = useState<AnalysisSnapshotSummary[]>([]);
  const [activeSnapshotId, setActiveSnapshotId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rightToolPanel, setRightToolPanel] = useState<RightToolPanel>(null);
  const requestPanelOpen = rightToolPanel === 'request';
  const runtimePanelOpen = rightToolPanel === 'runtime';
  const [requestTrace, setRequestTrace] = useState<RequestTrace | null>(null);
  const [tracePlayback, setTracePlayback] = useState<TracePlaybackOptions>({ speed: 1, playing: true });
  const [graphLayoutMode, setGraphLayoutMode] = useState<GraphLayoutMode>('services');
  const [mapNodePositions, setMapNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [mapNodeDimensions, setMapNodeDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [mapSelectedIds, setMapSelectedIds] = useState<Set<string>>(() => new Set());
  const activeRequest = useRef<AbortController | null>(null);
  const flowInstance = useRef<ReactFlowInstance | null>(null);
  const nativeDirectoryPicker = useMemo(() => hasNativeDirectoryPicker(), []);

  const applyAnalysis = useCallback((nextAnalysis: ProjectAnalysis, snapshotId: string | null = null) => {
    setAnalysis(nextAnalysis);
    setMapBlueprint(null);
    setMapSource('analysis');
    setActiveSnapshotId(snapshotId);
    setSelectedNode(null);
    setFocusNode(null);
    setRequestTrace(null);
    setRightToolPanel(null);
  }, []);

  const loadSnapshots = useCallback(async (targetProjectPath: string) => {
    const query = new URLSearchParams({ limit: '8', projectPath: targetProjectPath });
    const response = await apiFetch(`/api/snapshots?${query}`);
    if (!response.ok) throw new Error('Не удалось загрузить список снимков.');
    setSnapshots(await response.json() as AnalysisSnapshotSummary[]);
  }, []);

  const loadAnalysis = useCallback(async (url: string, init?: RequestInit) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(url, init);
      const payload = await response.json() as ProjectAnalysis | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Ошибка анализа');
      applyAnalysis(payload);
      await loadSnapshots(payload.summary.rootPath);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Неизвестная ошибка');
    } finally {
      setLoading(false);
    }
  }, [applyAnalysis, loadSnapshots]);

  const runBackgroundAnalysis = useCallback(async (
    path: string,
    compareRef?: string,
    priority: AnalysisJobPriority = 'normal',
  ) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setJobStatus('queued');
    setJobProgress({ phase: 'scanning', processedFiles: 0, totalFiles: 0, percentage: 0 });
    setError(null);
    let jobId: string | null = null;
    try {
      const createResponse = await apiFetch('/api/analysis-jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, priority, ...(compareRef ? { compareRef } : {}) }),
        signal: controller.signal,
      });
      const created = await createResponse.json() as AnalysisJob | { error: string };
      if (!createResponse.ok || 'error' in created) {
        throw new Error('error' in created ? created.error : 'Не удалось создать задание анализа.');
      }
      jobId = created.id;
      setActiveJobId(jobId);
      let job = created;
      while (job.status === 'queued' || job.status === 'running') {
        setJobStatus(job.status);
        setJobProgress(job.progress ?? null);
        await abortableDelay(300, controller.signal);
        const statusResponse = await apiFetch(`/api/analysis-jobs/${job.id}`, { signal: controller.signal });
        const statusPayload = await statusResponse.json() as AnalysisJob | { error: string };
        if (!statusResponse.ok || 'error' in statusPayload) {
          throw new Error('error' in statusPayload ? statusPayload.error : 'Не удалось получить статус задания.');
        }
        job = statusPayload;
      }
      setJobStatus(job.status);
      setJobProgress(job.progress ?? null);
      if (job.status === 'cancelled') return;
      if (job.status === 'failed' || !job.snapshotId) throw new Error(job.error ?? 'Анализ завершился с ошибкой.');

      const snapshotResponse = await apiFetch(`/api/snapshots/${job.snapshotId}`, { signal: controller.signal });
      const stored = await snapshotResponse.json() as StoredAnalysisSnapshot | { error: string };
      if (!snapshotResponse.ok || 'error' in stored) {
        throw new Error('error' in stored ? stored.error : 'Не удалось открыть готовый снимок.');
      }
      applyAnalysis(stored.analysis, stored.snapshot.id);
      await loadSnapshots(stored.analysis.summary.rootPath);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : 'Неизвестная ошибка');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setActiveJobId((current) => current === jobId ? null : current);
        setJobStatus(null);
        setJobProgress(null);
        setLoading(false);
      }
    }
  }, [applyAnalysis, loadSnapshots]);

  const cancelBackgroundAnalysis = useCallback(async () => {
    const jobId = activeJobId;
    if (!jobId) return;
    try {
      const response = await apiFetch(`/api/analysis-jobs/${jobId}`, { method: 'DELETE' });
      const payload = await response.json() as AnalysisJob | { error: string };
      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload ? payload.error : 'Не удалось отменить анализ.');
      }
      if (payload.status === 'cancelled') {
        setJobStatus('cancelled');
        activeRequest.current?.abort();
      }
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Не удалось отменить анализ.');
    }
  }, [activeJobId]);

  const openSnapshot = useCallback(async (snapshotId: string) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/snapshots/${snapshotId}`, { signal: controller.signal });
      const payload = await response.json() as StoredAnalysisSnapshot | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось открыть снимок.');
      applyAnalysis(payload.analysis, payload.snapshot.id);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : 'Неизвестная ошибка');
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [applyAnalysis]);

  useEffect(() => {
    void loadAnalysis('/api/demo');
  }, [loadAnalysis]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarOpen ? 'open' : 'collapsed');
    } catch {
      // The layout remains usable when storage is disabled by the host WebView.
    }
  }, [sidebarOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SOURCE_EDITOR_STORAGE_KEY, sourceEditor);
    } catch {
      // Editor choice remains active for this session when storage is unavailable.
    }
  }, [sourceEditor]);

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
    () => createFlowGraph(
      filteredGraph.nodes,
      filteredGraph.edges,
      deferredSearch,
      requestTrace,
      tracePlayback,
      graphLayoutMode,
      analysis?.nodes ?? filteredGraph.nodes,
      analysis?.edges ?? filteredGraph.edges,
    ),
    [analysis?.edges, analysis?.nodes, deferredSearch, filteredGraph, graphLayoutMode, requestTrace, tracePlayback],
  );

  const interactiveGraphNodes = useMemo<Node[]>(() => graph.nodes.map((node) => ({
    ...node,
    position: mapNodePositions[node.id] ?? node.position,
    selected: mapSelectedIds.has(node.id) || (mapSelectedIds.size === 0 && selectedNode?.id === node.id),
    ...(mapNodeDimensions[node.id] ? { measured: mapNodeDimensions[node.id] } : {}),
  })), [graph.nodes, mapNodeDimensions, mapNodePositions, mapSelectedIds, selectedNode?.id]);

  useEffect(() => {
    setMapNodePositions({});
    setMapNodeDimensions({});
    setMapSelectedIds(new Set());
  }, [analysis?.summary.rootPath, focusNode?.id, graphLayoutMode]);

  const handleMapNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change) => change.type === 'position' && Boolean(change.position));
    if (moved.length > 0) {
      setMapNodePositions((current) => {
        const next = { ...current };
        for (const change of moved) {
          if (change.type === 'position' && change.position) next[change.id] = change.position;
        }
        return next;
      });
    }
    const selectionChanges = changes.filter((change) => change.type === 'select');
    if (selectionChanges.length > 0) {
      setMapSelectedIds((current) => {
        const next = new Set(current);
        for (const change of selectionChanges) {
          if (change.type !== 'select') continue;
          if (change.selected) next.add(change.id); else next.delete(change.id);
        }
        return next;
      });
    }
    const dimensionChanges = changes.filter((change) => change.type === 'dimensions' && Boolean(change.dimensions));
    if (dimensionChanges.length > 0) {
      setMapNodeDimensions((current) => {
        const next = { ...current };
        for (const change of dimensionChanges) {
          if (change.type === 'dimensions' && change.dimensions) next[change.id] = change.dimensions;
        }
        return next;
      });
    }
  }, []);

  const handleMapSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams) => {
    setMapSelectedIds(new Set(nodes.filter((node) => node.selectable !== false).map((node) => node.id)));
    if (nodes.length !== 1) {
      setSelectedNode(null);
      return;
    }
    const atlas = (nodes[0].data as Partial<AtlasGraphNodeData>).atlas;
    setSelectedNode(atlas ?? null);
    if (atlas) setRightToolPanel(null);
  }, []);

  useEffect(() => {
    if (viewMode !== '2d' || !requestTrace || !flowInstance.current) return;
    const frame = window.requestAnimationFrame(() => fitRequestPath(flowInstance.current, requestTrace));
    return () => window.cancelAnimationFrame(frame);
  }, [graphLayoutMode, requestPanelOpen, requestTrace, runtimePanelOpen, viewMode]);

  const handleAnalyze = (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectPath.trim()) return;
    void runBackgroundAnalysis(projectPath.trim(), undefined, analysisPriority);
  };

  const handleChooseProjectDirectory = useCallback(async () => {
    setError(null);
    try {
      const selectedPath = await chooseProjectDirectory();
      if (selectedPath) setProjectPath(selectedPath);
    } catch (pickerError) {
      setError(pickerError instanceof Error
        ? `Не удалось открыть системный выбор папки: ${pickerError.message}`
        : 'Не удалось открыть системный выбор папки.');
    }
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler>((_event, flowNode) => {
    const atlas = (flowNode.data as Partial<AtlasGraphNodeData>).atlas;
    if (!atlas) return;
    setSelectedNode(atlas);
    setRightToolPanel(null);
  }, []);

  const openNodeSource = useCallback(async (node: AtlasNode, line?: number) => {
    if (!analysis) throw new Error('Сначала загрузите проект.');
    await openNodeInEditor(analysis.summary.rootPath, node, sourceEditor, line);
  }, [analysis, sourceEditor]);

  const handleNodeDoubleClick = useCallback<NodeMouseHandler>((event, flowNode) => {
    const atlas = (flowNode.data as Partial<AtlasGraphNodeData>).atlas;
    if (!atlas) return;
    const openSource = event.metaKey || event.ctrlKey || !diveableIds.has(atlas.id);
    if (openSource && sourceLocationForNode(atlas)) {
      void openNodeSource(atlas).catch((openError) => {
        setError(openError instanceof Error ? openError.message : 'Не удалось открыть исходник.');
      });
      return;
    }
    if (!diveableIds.has(atlas.id)) return;
    setFocusNode(atlas);
    setSelectedNode(null);
  }, [diveableIds, openNodeSource]);

  const changeViewMode = useCallback((mode: '2d' | '3d') => {
    startTransition(() => setViewMode(mode));
  }, []);

  const changeWorkspaceMode = useCallback((mode: 'map' | 'constructor') => {
    startTransition(() => setWorkspaceMode(mode));
    setRightToolPanel(null);
    setSelectedNode(null);
    setMapSelectedIds(new Set());
  }, []);

  const openBlueprintOnMap = useCallback((
    document: ArchitectureBlueprintDraft,
    name: string,
    id: string | null,
  ) => {
    setMapBlueprint({ id, name, document });
    setMapSource('blueprint');
    setViewMode('2d');
    setWorkspaceMode('map');
    setRightToolPanel(null);
    setSelectedNode(null);
    setMapSelectedIds(new Set());
  }, []);

  const openActualMap = useCallback(() => {
    setMapSource('analysis');
    setRightToolPanel(null);
    setSelectedNode(null);
    setMapSelectedIds(new Set());
  }, []);

  const diveIntoSelected = useCallback(() => {
    if (!selectedNode || !diveableIds.has(selectedNode.id)) return;
    startTransition(() => {
      setFocusNode(selectedNode);
      setSelectedNode(null);
    });
  }, [diveableIds, selectedNode]);

  const selectDiagnostic = useCallback((diagnostic: ProjectDiagnostic) => {
    const target = analysis?.nodes.find((node) => diagnostic.nodeIds.includes(node.id));
    if (!target) return;
    startTransition(() => {
      setFocusNode(null);
      setSelectedNode(target);
    });
    setRightToolPanel(null);
  }, [analysis]);

  const compareWithGitReference = useCallback((compareRef: string) => {
    if (!analysis) return;
    void runBackgroundAnalysis(analysis.summary.rootPath, compareRef);
  }, [analysis, runBackgroundAnalysis]);

  const selectedDiagnostics = useMemo(() => (
    selectedNode ? analysis?.diagnostics.filter((item) => item.nodeIds.includes(selectedNode.id)) ?? [] : []
  ), [analysis?.diagnostics, selectedNode]);

  const handleRequestTrace = useCallback((nextTrace: RequestTrace | null) => {
    setRequestTrace(nextTrace);
    if (!nextTrace) return;
    setFocusNode(null);
    setSearch('');
    setVisibleKinds((current) => {
      const next = new Set(current);
      for (const nodeId of nextTrace.nodeIds) {
        const kind = analysis?.nodes.find((node) => node.id === nodeId)?.kind;
        if (kind) next.add(kind);
      }
      return next;
    });
  }, [analysis?.nodes]);

  const selectRequestTraceNode = useCallback((nodeId: string) => {
    const node = analysis?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    setSelectedNode(node);
    setRightToolPanel(null);
  }, [analysis?.nodes]);

  const selectGraph3DNode = useCallback((node: AtlasNode | null) => {
    setSelectedNode(node);
    if (node) setRightToolPanel(null);
  }, []);

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
    <main className={sidebarOpen ? 'app-shell' : 'app-shell is-sidebar-collapsed'}>
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
          {nativeDirectoryPicker ? (
            <button
              className="path-form__picker"
              type="button"
              disabled={loading}
              aria-label="Выбрать папку проекта"
              title="Выбрать папку проекта"
              onClick={() => void handleChooseProjectDirectory()}
            >Папка</button>
          ) : null}
          {jobStatus === 'queued' || jobStatus === 'running' ? (
            <button
              className="path-form__cancel"
              type="button"
              disabled={!activeJobId}
              onClick={() => void cancelBackgroundAnalysis()}
            >
              Отменить{jobProgress ? ` · ${jobProgress.percentage}%` : ''}
            </button>
          ) : (
            <>
              <button
                className={`path-form__priority ${analysisPriority === 'high' ? 'is-active' : ''}`}
                type="button"
                disabled={loading}
                aria-pressed={analysisPriority === 'high'}
                aria-label="Высокий приоритет анализа"
                title="Высокий приоритет: задание обойдёт обычные задания в очереди"
                onClick={() => setAnalysisPriority((current) => current === 'high' ? 'normal' : 'high')}
              >⚡</button>
              <button type="submit" disabled={loading || !projectPath.trim()}>Построить карту</button>
            </>
          )}
        </form>
        {workspaceMode === 'map' && !(mapSource === 'blueprint' && mapBlueprint) ? (
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
        ) : <div className="view-switch view-switch--blueprint"><span>{workspaceMode === 'map' ? 'Blueprint map' : 'Blueprint'}</span></div>}
      </header>

      <ProjectSidebar
        summary={analysis.summary}
        onCompare={compareWithGitReference}
        snapshots={snapshots}
        activeSnapshotId={activeSnapshotId}
        onOpenSnapshot={openSnapshot}
        loading={loading}
        blueprint={mapSource === 'blueprint' ? mapBlueprint : null}
      />

      <section className={`canvas-shell ${workspaceMode === 'map' && mapSource === 'analysis' && requestPanelOpen ? 'is-request-panel-open' : ''} ${workspaceMode === 'map' && mapSource === 'analysis' && runtimePanelOpen ? 'is-runtime-panel-open' : ''}`}>
        <div className="canvas-toolbar">
          <div className="canvas-toolbar__context">
            <button
              type="button"
              className="sidebar-toggle"
              aria-controls="project-sidebar"
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? 'Скрыть левую панель' : 'Показать левую панель'}
              title={sidebarOpen ? 'Скрыть левую панель' : 'Показать левую панель'}
              onClick={() => setSidebarOpen((current) => !current)}
            ><span aria-hidden="true">{sidebarOpen ? '‹' : '☰'}</span></button>
            <span className="pulse" />
            {workspaceMode === 'map' && mapSource === 'blueprint' && mapBlueprint ? (
              <><strong className="blueprint-toolbar-title">Blueprint · {mapBlueprint.name}</strong><small>{mapBlueprint.document.nodes.length} узлов · {mapBlueprint.document.edges.length} связей</small></>
            ) : workspaceMode === 'map' ? (
              <>
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
                <small>{filteredGraph.nodes.length} узлов · {graph.edges.length} связей</small>
              </>
            ) : <><strong className="blueprint-toolbar-title">Architecture Blueprint</strong><small>целевая архитектура · план ↔ факт</small></>}
          </div>
          <div className="canvas-toolbar__actions">
            <div className="workspace-mode-toggle" role="group" aria-label="Рабочий режим">
              <button type="button" className={workspaceMode === 'map' ? 'is-active' : ''} onClick={() => changeWorkspaceMode('map')}>Карта</button>
              <button
                type="button"
                className={workspaceMode === 'constructor' ? 'is-active' : ''}
                onMouseEnter={() => void import('./components/ArchitectureConstructor')}
                onFocus={() => void import('./components/ArchitectureConstructor')}
                onClick={() => changeWorkspaceMode('constructor')}
              >Конструктор</button>
            </div>
            {workspaceMode === 'map' && mapBlueprint ? (
              <div className="map-source-toggle" role="group" aria-label="Источник карты">
                <button type="button" className={mapSource === 'analysis' ? 'is-active' : ''} onClick={openActualMap}>Код</button>
                <button type="button" className={mapSource === 'blueprint' ? 'is-active' : ''} onClick={() => { setMapSource('blueprint'); setViewMode('2d'); setRightToolPanel(null); }}>Blueprint</button>
              </div>
            ) : null}
            {workspaceMode === 'map' && mapSource === 'analysis' && viewMode === '2d' ? (
              <div className="graph-layout-toggle" role="group" aria-label="Раскладка 2D-карты">
                <button
                  type="button"
                  className={graphLayoutMode === 'services' ? 'is-active' : ''}
                  aria-pressed={graphLayoutMode === 'services'}
                  onClick={() => startTransition(() => setGraphLayoutMode('services'))}
                >Сервисы</button>
                <button
                  type="button"
                  className={graphLayoutMode === 'layers' ? 'is-active' : ''}
                  aria-pressed={graphLayoutMode === 'layers'}
                  onClick={() => startTransition(() => setGraphLayoutMode('layers'))}
                >Слои</button>
              </div>
            ) : null}
            {workspaceMode === 'map' && mapSource === 'analysis' ? (
              <>
                <DiagnosticsMenu diagnostics={analysis.diagnostics} onSelect={selectDiagnostic} />
                <MapFilters visibleKinds={visibleKinds} onChange={setVisibleKinds} />
                <button
                  type="button"
                  className={`request-trace-toggle ${requestPanelOpen ? 'is-active' : ''}`}
                  aria-pressed={requestPanelOpen}
                  onClick={() => {
                    setSelectedNode(null);
                    setMapSelectedIds(new Set());
                    setRightToolPanel((current) => current === 'request' ? null : 'request');
                  }}
                ><span>↗</span> Запрос</button>
                <button
                  type="button"
                  className={`request-trace-toggle runtime-trace-toggle ${runtimePanelOpen ? 'is-active' : ''}`}
                  aria-pressed={runtimePanelOpen}
                  onMouseEnter={() => void import('./components/RuntimeTracePanel')}
                  onFocus={() => void import('./components/RuntimeTracePanel')}
                  onClick={() => {
                    setSelectedNode(null);
                    setMapSelectedIds(new Set());
                    setRightToolPanel((current) => current === 'runtime' ? null : 'runtime');
                  }}
                ><span>⌁</span> Трейсы</button>
                <label className="search-field">
                  <span>⌕</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти модуль, класс, путь…" />
                </label>
              </>
            ) : null}
          </div>
        </div>

        {error ? <div className="error-banner">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
        {mapSource === 'analysis' ? analysis.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>) : null}

        {workspaceMode === 'constructor' ? (
          <Suspense fallback={<div className="loading-overlay"><span />Загружаем конструктор…</div>}>
            <ArchitectureConstructor key={analysis.summary.rootPath} analysis={analysis} onOpenOnMap={openBlueprintOnMap} />
          </Suspense>
        ) : mapSource === 'blueprint' && mapBlueprint ? (
          <Suspense fallback={<div className="loading-overlay"><span />Открываем Blueprint на карте…</div>}>
            <BlueprintMapView name={mapBlueprint.name} document={mapBlueprint.document} onEdit={() => changeWorkspaceMode('constructor')} />
          </Suspense>
        ) : viewMode === '2d' ? (
          <div className="graph-viewport">
            <ReactFlow
              key={`${graphLayoutMode}:${focusNode?.id ?? 'root'}:${requestPanelOpen || runtimePanelOpen ? 'trace-open' : 'trace-closed'}`}
              nodes={interactiveGraphNodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(instance) => {
                flowInstance.current = instance;
                if (requestTrace) window.requestAnimationFrame(() => fitRequestPath(instance, requestTrace));
              }}
              onNodesChange={handleMapNodesChange}
              onSelectionChange={handleMapSelectionChange}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onPaneClick={() => {
                setSelectedNode(null);
                setMapSelectedIds(new Set());
              }}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnDrag={[1]}
              panActivationKeyCode="Space"
              panOnScroll
              panOnScrollSpeed={0.8}
              zoomOnScroll={false}
              multiSelectionKeyCode="Shift"
              fitView
              fitViewOptions={{ padding: 0.24 }}
              minZoom={0.18}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} color="#29303c" gap={22} size={1.2} />
              <Controls className="atlas-map-controls" position="bottom-right" showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                nodeColor={(node) => {
                  const data = node.data as Partial<AtlasGraphNodeData> & Partial<GraphZoneNodeData>;
                  if (!data.atlas) return data.traceState === 'failure' ? '#6f2c39' : data.traceState === 'path' ? '#245c50' : '#16202a';
                  return data.requestTraceState === 'failure' ? '#f06f83' : data.requestTraceState === 'path' ? '#7ee2c5' : COLOR_BY_KIND[data.atlas.kind];
                }}
                maskColor="rgba(6, 8, 13, .72)"
              />
            </ReactFlow>
            <div className="figma-navigation-hint" aria-hidden="true"><span>↖ рамка — группа</span><span>drag — узлы</span><span>Space + drag / колесо — карта</span></div>
          </div>
        ) : (
          <Suspense fallback={<div className="loading-overlay"><span />Загружаем 3D-движок…</div>}>
            <Graph3D
              nodes={filteredGraph.nodes}
              edges={filteredGraph.edges}
              search={deferredSearch}
              selectedId={selectedNode?.id}
              requestTrace={requestTrace}
              tracePlayback={tracePlayback}
              onSelect={selectGraph3DNode}
            />
          </Suspense>
        )}

        {loading ? (
          <div className="loading-overlay">
            <span className="loading-spinner" />
            <div className="analysis-progress">
              <strong>{analysisProgressLabel(jobStatus, jobProgress)}</strong>
              {jobStatus === 'running' && jobProgress ? (
                <>
                  <div
                    className="analysis-progress__track"
                    role="progressbar"
                    aria-label="Прогресс анализа проекта"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={jobProgress.percentage}
                  >
                    <i style={{ width: `${jobProgress.percentage}%` }} />
                  </div>
                  <small>
                    {jobProgress.totalFiles > 0
                      ? `${jobProgress.processedFiles} / ${jobProgress.totalFiles} файлов`
                      : 'Подготавливаем список файлов'}
                    {' · '}{jobProgress.percentage}%
                  </small>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {workspaceMode === 'map' && mapSource === 'analysis' ? (
          <>
            <RequestTracePanel
              key={`${analysis.summary.rootPath}:${activeSnapshotId ?? 'live'}`}
              analysis={analysis}
              open={requestPanelOpen}
              trace={requestTrace}
              playback={tracePlayback}
              onClose={() => setRightToolPanel((current) => current === 'request' ? null : current)}
              onTrace={handleRequestTrace}
              onPlaybackChange={setTracePlayback}
              onSelectNode={selectRequestTraceNode}
            />
            {runtimePanelOpen ? (
              <Suspense fallback={null}>
                <RuntimeTracePanel
                  analysis={analysis}
                  open={runtimePanelOpen}
                  playback={tracePlayback}
                  onClose={() => setRightToolPanel((current) => current === 'runtime' ? null : current)}
                  onTrace={handleRequestTrace}
                  onPlaybackChange={setTracePlayback}
                  onSelectNode={selectRequestTraceNode}
                />
              </Suspense>
            ) : null}
          </>
        ) : null}
      </section>

      {workspaceMode === 'map' && mapSource === 'analysis' ? (
        <Inspector
          node={rightToolPanel ? null : selectedNode}
          onClose={() => setSelectedNode(null)}
          canDive={Boolean(selectedNode && diveableIds.has(selectedNode.id))}
          onDive={diveIntoSelected}
          diagnostics={selectedDiagnostics}
          sourceEditor={sourceEditor}
          onSourceEditorChange={setSourceEditor}
          onOpenSource={openNodeSource}
        />
      ) : null}
    </main>
  );
}

function analysisProgressLabel(status: AnalysisJobStatus | null, progress: AnalysisProgress | null): string {
  if (status === 'queued') return 'Задание ожидает свободный worker…';
  if (status !== 'running' || !progress) return 'Загружаем карту…';
  switch (progress.phase) {
    case 'scanning': return 'Сканируем структуру проекта…';
    case 'parsing': return 'Разбираем исходный код…';
    case 'comparing': return 'Сравниваем с Git-версией…';
    case 'finalizing': return 'Собираем граф и сохраняем снимок…';
  }
}

function readSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function readSourceEditorPreference(): SourceEditor {
  try {
    const stored = window.localStorage.getItem(SOURCE_EDITOR_STORAGE_KEY);
    if (stored === 'vscode' || stored === 'cursor' || stored === 'system' || stored === 'simple') return stored;
  } catch {
    // Use VS Code when storage is unavailable.
  }
  return 'vscode';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  requestTrace: RequestTrace | null,
  tracePlayback: TracePlaybackOptions,
  layoutMode: GraphLayoutMode,
  hierarchyNodes: AtlasNode[],
  hierarchyEdges: AtlasEdge[],
): { nodes: Node[]; edges: Edge[] } {
  const visibleAtlasNodes = atlasNodes;
  const visibleIds = new Set(visibleAtlasNodes.map((node) => node.id));
  const matchingIds = new Set(
    search
      ? visibleAtlasNodes
          .filter((node) => `${node.label} ${node.path ?? ''} ${node.language ?? ''}`.toLowerCase().includes(search))
          .map((node) => node.id)
      : visibleIds,
  );
  const requestNodeIds = new Set(requestTrace?.nodeIds ?? []);
  const requestEdgeIds = new Set(requestTrace?.edgeIds ?? []);
  const failureNodeId = requestTrace?.probableFailure?.nodeId;
  const traceEdgeIndex = new Map((requestTrace?.edgeIds ?? []).map((edgeId, index) => [edgeId, index]));
  const layout = layoutAtlasGraph(visibleAtlasNodes, atlasEdges, layoutMode, hierarchyNodes, hierarchyEdges);

  const zoneNodes: Node<GraphZoneNodeData>[] = layout.zones.map((zone) => {
    const containsFailure = Boolean(failureNodeId && zone.nodeIds.includes(failureNodeId));
    const containsPath = zone.nodeIds.some((nodeId) => requestNodeIds.has(nodeId));
    return {
      id: zone.id,
      type: zone.kind === 'service' ? 'serviceZone' : 'layerZone',
      position: zone.position,
      data: {
        kind: zone.kind,
        title: zone.title,
        subtitle: zone.subtitle,
        traceState: containsFailure ? 'failure' : containsPath ? 'path' : undefined,
      },
      style: { width: zone.width, height: zone.height, zIndex: -1 },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
    };
  });

  const atlasFlowNodes = visibleAtlasNodes.map((atlas): Node<AtlasGraphNodeData> => {
    return {
      id: atlas.id,
      type: 'atlas',
      position: layout.positions.get(atlas.id) ?? { x: 0, y: 0 },
      data: {
        atlas,
        dimmed: Boolean(search) && !matchingIds.has(atlas.id) && !requestNodeIds.has(atlas.id),
        requestTraceState: atlas.id === failureNodeId ? 'failure' : requestNodeIds.has(atlas.id) ? 'path' : undefined,
      },
      draggable: true,
      selected: false,
    };
  });

  const edges = atlasEdges
    .filter((item) => visibleIds.has(item.source) && visibleIds.has(item.target))
    .map((item): Edge => {
      const isRequestPath = requestEdgeIds.has(item.id);
      const leadsToFailure = isRequestPath && item.target === failureNodeId;
      const traceIndex = traceEdgeIndex.get(item.id) ?? 0;
      return {
        id: item.id,
        source: item.source,
        target: item.target,
        label: item.kind === 'imports' ? undefined : item.kind,
        type: isRequestPath ? 'requestTrace' : 'smoothstep',
        data: isRequestPath ? {
          traceIndex,
          traceCount: requestTrace?.edgeIds.length ?? 1,
          leadsToFailure,
          playbackSpeed: tracePlayback.speed,
          playing: tracePlayback.playing,
        } satisfies RequestTraceEdgeData : undefined,
        animated: !isRequestPath && item.change !== 'removed' && (item.change === 'added' || item.kind === 'imports' || item.kind === 'calls'),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: {
          stroke: leadsToFailure ? '#f06f83' : isRequestPath ? '#7ee2c5' : item.change === 'removed' ? '#b95768' : item.change === 'added' ? '#c9ae55' : item.kind === 'imports' ? '#416b8c' : item.kind === 'calls' ? '#d18b55' : item.kind === 'uses' ? '#9b6586' : '#3b4350',
          strokeWidth: isRequestPath ? 2.6 : item.kind === 'contains' ? 1 : 1.5,
          strokeDasharray: item.change === 'removed' ? '5 4' : undefined,
          opacity: isRequestPath ? 1 : item.change === 'removed' ? 0.72 : 1,
        },
        labelStyle: { fill: isRequestPath ? '#98ead4' : '#667083', fontSize: 9 },
        labelBgStyle: { fill: '#0d1017', fillOpacity: 0.8 },
      };
    });

  return { nodes: [...zoneNodes, ...atlasFlowNodes], edges };
}

function fitRequestPath(instance: ReactFlowInstance | null, trace: RequestTrace): void {
  if (!instance) return;
  const nodes = trace.nodeIds
    .map((nodeId) => instance.getNode(nodeId))
    .filter((node): node is Node => Boolean(node));
  if (nodes.length === 0) return;
  void instance.fitView({ nodes, padding: 0.34, duration: 360, maxZoom: 0.92 });
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
