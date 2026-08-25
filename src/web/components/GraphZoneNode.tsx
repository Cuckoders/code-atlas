import type { NodeProps } from '@xyflow/react';

export interface GraphZoneNodeData extends Record<string, unknown> {
  kind: 'service' | 'layer';
  title: string;
  subtitle: string;
  traceState?: 'path' | 'failure';
}

export function GraphZoneNode({ data }: NodeProps) {
  const zone = data as GraphZoneNodeData;
  return (
    <section className={`graph-zone graph-zone--${zone.kind} ${zone.traceState ? `is-request-${zone.traceState}` : ''}`}>
      <header>
        <i />
        <strong>{zone.title}</strong>
        <span>{zone.subtitle}</span>
      </header>
    </section>
  );
}
