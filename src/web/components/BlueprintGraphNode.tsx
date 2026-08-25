import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BlueprintNodeKind, BlueprintNodeStatus } from '../../shared/blueprint';

export type BlueprintDriftState = 'matched' | 'planned-only' | 'actual-only';

export interface BlueprintGraphNodeData extends Record<string, unknown> {
  label: string;
  kind: BlueprintNodeKind;
  status: BlueprintNodeStatus;
  subtitle?: string;
  drift: BlueprintDriftState;
  readOnly?: boolean;
}

const KIND_ICON: Record<BlueprintNodeKind, string> = {
  system: '◇',
  service: '⬡',
  frontend: '▱',
  gateway: '↔',
  controller: '⌁',
  module: '▤',
  component: 'C',
  class: 'C',
  'abstract-class': 'A',
  interface: 'I',
  database: '◉',
  cache: '◆',
  queue: '≋',
  external: '↗',
};

const DRIFT_LABEL: Record<BlueprintDriftState, string> = {
  matched: 'совпадает',
  'planned-only': 'только план',
  'actual-only': 'только факт',
};

export function BlueprintGraphNode({ data, selected }: NodeProps) {
  const node = data as BlueprintGraphNodeData;
  return (
    <div className={`blueprint-node blueprint-node--${node.kind} blueprint-node--${node.drift} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="blueprint-handle" />
      <div className="blueprint-node__icon" aria-hidden="true">{KIND_ICON[node.kind]}</div>
      <div className="blueprint-node__body">
        <span>{node.kind}</span>
        <strong>{node.label}</strong>
        <small>{node.subtitle ?? node.status}</small>
      </div>
      <i>{DRIFT_LABEL[node.drift]}</i>
      <Handle type="source" position={Position.Right} className="blueprint-handle" />
    </div>
  );
}
