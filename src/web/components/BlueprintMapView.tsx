import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  applyNodeChanges,
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
} from '@xyflow/react';
import type {
  ArchitectureBlueprintDraft,
  BlueprintEdgeKind,
  BlueprintNode,
} from '../../shared/blueprint';
import type { BlueprintSimulationResult } from '../../shared/blueprint-simulation';
import { BlueprintGraphNode, type BlueprintGraphNodeData } from './BlueprintGraphNode';

const nodeTypes = { blueprint: BlueprintGraphNode };
const BlueprintSimulationPanel = lazy(() => import('./BlueprintSimulationPanel'));

const EDGE_LABELS: Record<BlueprintEdgeKind, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  event: 'Событие',
  reads: 'Читает',
  writes: 'Пишет',
  depends: 'Зависит',
  implements: 'Реализует',
  extends: 'Наследует',
  creates: 'Создаёт',
  calls: 'Вызывает',
};

const STATUS_LABELS = {
  planned: 'Запланирован',
  approved: 'Согласован',
  implemented: 'Реализован',
} as const;

interface BlueprintMapViewProps {
  name: string;
  document: ArchitectureBlueprintDraft;
  onEdit?: () => void;
}

export default function BlueprintMapView({ name, document, onEdit }: BlueprintMapViewProps) {
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [simulationResult, setSimulationResult] = useState<BlueprintSimulationResult | null>(null);
  const [simulationStep, setSimulationStep] = useState(-1);
  const activeSimulationStep = simulationResult?.steps[simulationStep] ?? null;
  const visitedNodeIds = useMemo(
    () => new Set(simulationResult?.steps.slice(0, Math.max(0, simulationStep + 1)).map((step) => step.nodeId) ?? []),
    [simulationResult, simulationStep],
  );
  const sourceNodes = useMemo(() => document.nodes.map((node) => toFlowNode(
    node,
    activeSimulationStep?.nodeId === node.id
      ? activeSimulationStep.status === 'failed' ? 'failed' : 'active'
      : visitedNodeIds.has(node.id) ? 'visited' : undefined,
  )), [activeSimulationStep, document.nodes, visitedNodeIds]);
  const [nodes, setNodes] = useState(sourceNodes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedNode = document.nodes.find((node) => node.id === selectedId) ?? null;
  const edges = useMemo<Edge[]>(() => document.edges.map((edge) => {
    const isActive = activeSimulationStep?.viaEdgeId === edge.id;
    return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? EDGE_LABELS[edge.kind],
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(edge.kind) },
    style: { stroke: isActive ? '#b8ffe9' : edgeColor(edge.kind), strokeWidth: isActive ? 3 : 1.7 },
    labelStyle: { fill: '#758596', fontFamily: 'DM Mono', fontSize: 8 },
    labelBgStyle: { fill: '#0b0f15', fillOpacity: 0.92 },
    };
  }), [activeSimulationStep?.viaEdgeId, document.edges]);

  useEffect(() => {
    setNodes(sourceNodes);
    setSelectedId(null);
  }, [sourceNodes]);

  const handleNodesChange = (changes: NodeChange<Node<BlueprintGraphNodeData>>[]) => {
    setNodes((current) => applyNodeChanges<Node<BlueprintGraphNodeData>>(changes, current));
  };

  return (
    <div className="graph-viewport blueprint-map-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={(_event, node) => { setSelectedId(node.id); setSimulationOpen(false); }}
        onPaneClick={() => setSelectedId(null)}
        nodesConnectable={false}
        elementsSelectable
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1]}
        panActivationKeyCode="Space"
        panOnScroll
        panOnScrollSpeed={0.8}
        zoomOnScroll={false}
        multiSelectionKeyCode="Shift"
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="#29303c" gap={22} size={1.2} />
        <Controls className="atlas-map-controls" position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel={`Мини-карта Blueprint ${name}`}
          bgColor="#0b0f15"
          maskColor="rgba(6, 8, 13, .72)"
          nodeBorderRadius={8}
          nodeStrokeColor="#91e4cc"
          nodeStrokeWidth={2}
          nodeColor={(node) => node.data.status === 'implemented' ? '#2b715f' : '#25577c'}
        />
      </ReactFlow>

      <div className="blueprint-map-badge">
        <span>Карта Blueprint</span>
        <strong>{name}</strong>
        <small>{document.nodes.length} узлов · {document.edges.length} связей</small>
        <button type="button" onClick={() => { setSelectedId(null); setSimulationOpen(true); }}>▶ Запустить логику</button>
      </div>

      {simulationOpen ? (
        <Suspense fallback={null}>
          <BlueprintSimulationPanel
            document={document}
            result={simulationResult}
            activeStep={simulationStep}
            onResult={(result) => { setSimulationResult(result); setSimulationStep(0); }}
            onSelectStep={setSimulationStep}
            onClose={() => { setSimulationOpen(false); setSimulationStep(-1); }}
          />
        </Suspense>
      ) : null}

      {selectedNode ? (
        <aside className="blueprint-map-details">
          <header><span>Компонент Blueprint</span><button type="button" onClick={() => setSelectedId(null)} aria-label="Закрыть">×</button></header>
          <h2>{selectedNode.label}</h2>
          <dl>
            <div><dt>Тип</dt><dd>{selectedNode.kind}</dd></div>
            <div><dt>Статус</dt><dd>{STATUS_LABELS[selectedNode.status]}</dd></div>
            {selectedNode.technology ? <div><dt>Технология</dt><dd>{selectedNode.technology}</dd></div> : null}
            {selectedNode.language ? <div><dt>Язык</dt><dd>{selectedNode.language}</dd></div> : null}
            {selectedNode.owner ? <div><dt>Владелец</dt><dd>{selectedNode.owner}</dd></div> : null}
            {selectedNode.behavior ? <div><dt>Логика</dt><dd>{selectedNode.behavior.kind}</dd></div> : null}
            {selectedNode.codegen?.enabled ? <div><dt>Шаблон</dt><dd>{selectedNode.codegen.template}</dd></div> : null}
          </dl>
          {onEdit ? <button type="button" className="blueprint-map-details__edit" onClick={onEdit}>Редактировать в конструкторе</button> : null}
        </aside>
      ) : null}

      <div className="figma-navigation-hint" aria-hidden="true"><span>↖ рамка — группа</span><span>drag — узлы</span><span>Space + drag / колесо — карта</span></div>
    </div>
  );
}

function toFlowNode(node: BlueprintNode, simulationState?: BlueprintGraphNodeData['simulationState']): Node<BlueprintGraphNodeData> {
  return {
    id: node.id,
    type: 'blueprint',
    position: node.position,
    data: {
      label: node.label,
      kind: node.kind,
      status: node.status,
      subtitle: node.technology ?? node.language ?? STATUS_LABELS[node.status],
      drift: node.actualNodeId || node.status === 'implemented' ? 'matched' : 'planned-only',
      readOnly: true,
      ...(simulationState ? { simulationState } : {}),
    },
  };
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
