import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';

export interface RequestTraceEdgeData extends Record<string, unknown> {
  traceIndex: number;
  traceCount: number;
  leadsToFailure: boolean;
}

type RequestTraceFlowEdge = Edge<RequestTraceEdgeData, 'requestTrace'>;

export function RequestTraceEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps<RequestTraceFlowEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const traceIndex = data?.traceIndex ?? 0;
  const traceCount = Math.max(1, data?.traceCount ?? 1);
  const delay = (traceIndex * 0.22).toFixed(2);
  const duration = Math.max(1.1, Math.min(2.2, traceCount * 0.18)).toFixed(2);

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <span className="request-trace-edge__label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
      <circle className="request-trace-edge__packet" r="4.2" aria-hidden="true">
        <animateMotion path={edgePath} begin={`${delay}s`} dur={`${duration}s`} repeatCount="indefinite" />
      </circle>
      {data?.leadsToFailure ? (
        <circle className="request-trace-edge__impact" cx={targetX} cy={targetY} r="8" aria-hidden="true" />
      ) : null}
    </>
  );
}
