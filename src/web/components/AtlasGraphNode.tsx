import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AtlasNode, NodeKind } from '../../shared/graph';

export interface AtlasGraphNodeData extends Record<string, unknown> {
  atlas: AtlasNode;
  dimmed: boolean;
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
  const { atlas, dimmed } = nodeData;
  return (
    <div className={`atlas-node atlas-node--${atlas.kind} ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}`}>
      <Handle type="target" position={Position.Left} className="atlas-handle" />
      <div className="atlas-node__icon" aria-hidden="true">{KIND_ICON[atlas.kind]}</div>
      <div className="atlas-node__body">
        <span className="atlas-node__kind">{atlas.kind}</span>
        <strong>{atlas.label}</strong>
        {atlas.subtitle ? <small>{atlas.subtitle}</small> : null}
      </div>
      {atlas.members?.length ? <span className="atlas-node__count">{atlas.members.length}</span> : null}
      <Handle type="source" position={Position.Right} className="atlas-handle" />
    </div>
  );
}
