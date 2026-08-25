import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AtlasNode, NodeKind } from '../../shared/graph';

export interface AtlasGraphNodeData extends Record<string, unknown> {
  atlas: AtlasNode;
  dimmed: boolean;
  requestTraceState?: 'path' | 'failure';
}

const KIND_ICON: Record<NodeKind, string> = {
  project: '◇',
  service: '⬡',
  database: '◉',
  module: '▤',
  controller: '⌁',
  class: 'C',
  interface: 'I',
  function: 'ƒ',
};

export function AtlasGraphNode({ data, selected }: NodeProps) {
  const nodeData = data as AtlasGraphNodeData;
  const { atlas, dimmed, requestTraceState } = nodeData;
  const diffStatus = typeof atlas.metadata?.diffStatus === 'string' ? atlas.metadata.diffStatus : null;
  const changeLabel = diffStatus === 'added' ? 'A' : diffStatus === 'modified' ? 'M' : diffStatus === 'removed' ? 'R' : null;
  return (
    <div className={`atlas-node atlas-node--${atlas.kind} ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''} ${requestTraceState ? `is-request-${requestTraceState}` : ''} ${diffStatus ? `atlas-node--diff-${diffStatus}` : ''}`}>
      <Handle type="target" position={Position.Left} className="atlas-handle" />
      <div className="atlas-node__icon" aria-hidden="true">{KIND_ICON[atlas.kind]}</div>
      <div className="atlas-node__body">
        <span className="atlas-node__kind">{atlas.kind}</span>
        <strong>{atlas.label}</strong>
        {atlas.subtitle ? <small>{atlas.subtitle}</small> : null}
      </div>
      {atlas.members?.length ? <span className="atlas-node__count">{atlas.members.length}</span> : null}
      {changeLabel ? <span className="atlas-node__change">Δ {changeLabel}</span> : null}
      <Handle type="source" position={Position.Right} className="atlas-handle" />
    </div>
  );
}
