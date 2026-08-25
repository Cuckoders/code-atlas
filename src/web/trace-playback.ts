import type { MappedRuntimeTrace } from '../shared/runtime-trace';
import type { RequestTrace } from '../shared/request-trace';

export const TRACE_PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;

export interface TracePlaybackOptions {
  speed: number;
  playing: boolean;
}

export function traceAtRuntimeSpan(mapped: MappedRuntimeTrace, playhead: number): RequestTrace {
  const safePlayhead = Math.max(0, Math.min(mapped.spans.length - 1, playhead));
  const reachedNodeIds: string[] = [];
  for (const span of mapped.spans.slice(0, safePlayhead + 1)) {
    if (span.nodeId && !reachedNodeIds.includes(span.nodeId)) reachedNodeIds.push(span.nodeId);
  }
  const reachedNodes = new Set(reachedNodeIds);
  const failureIndex = runtimeFailureIndex(mapped);
  return {
    ...(mapped.trace.matchedRoute ? { matchedRoute: mapped.trace.matchedRoute } : {}),
    steps: mapped.trace.steps.filter((step) => reachedNodes.has(step.nodeId)),
    nodeIds: reachedNodeIds,
    edgeIds: mapped.trace.edgeIds.slice(0, Math.max(0, reachedNodeIds.length - 1)),
    ...(mapped.trace.probableFailure && failureIndex >= 0 && safePlayhead >= failureIndex
      ? { probableFailure: mapped.trace.probableFailure }
      : {}),
  };
}

export function runtimeFailureIndex(mapped: MappedRuntimeTrace): number {
  return mapped.spans.findIndex((span) => (
    span.status === 'error' || span.events.some((event) => event.name === 'exception')
  ));
}

export function runtimeStepDelay(milliseconds: number, speed: number): number {
  const readableDelay = Math.max(360, Math.min(1_400, 480 + milliseconds * 18));
  return readableDelay / Math.max(0.25, speed);
}
