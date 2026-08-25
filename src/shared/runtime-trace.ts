import type { AtlasNode, NodeKind, ProjectAnalysis } from './graph.js';
import type { RequestTrace, RequestTraceRole } from './request-trace.js';

export type RuntimeSpanStatus = 'unset' | 'ok' | 'error';
export type RuntimeAttributeValue = string | number | boolean;

export interface RuntimeSpanEvent {
  name: string;
  timeUnixNano?: string;
  attributes: Record<string, RuntimeAttributeValue>;
}

export interface RuntimeSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  status: RuntimeSpanStatus;
  statusMessage?: string;
  attributes: Record<string, RuntimeAttributeValue>;
  events: RuntimeSpanEvent[];
}

export interface RuntimeTraceSummary {
  id: string;
  projectPath: string;
  traceId: string;
  name: string;
  createdAt: string;
  startedAt: string;
  durationMs: number;
  status: RuntimeSpanStatus;
  spanCount: number;
  errorCount: number;
  serviceNames: string[];
}

export interface RuntimeTraceSession {
  summary: RuntimeTraceSummary;
  spans: RuntimeSpan[];
}

export interface MappedRuntimeSpan extends RuntimeSpan {
  nodeId?: string;
  matchReason?: string;
  pathNodeIds?: string[];
  pathEdgeIds?: string[];
}

export interface MappedRuntimeTrace {
  session: RuntimeTraceSession;
  spans: MappedRuntimeSpan[];
  trace: RequestTrace;
}

export function mapRuntimeTrace(analysis: ProjectAnalysis, session: RuntimeTraceSession): MappedRuntimeTrace {
  const spans = session.spans
    .slice()
    .sort(compareSpans)
    .map((span) => ({ ...span, ...matchSpan(analysis.nodes, span) }))
    .map((span): MappedRuntimeSpan => {
      if (!span.nodeId) return span;
      const path = hierarchyPath(analysis, span.nodeId);
      return { ...span, pathNodeIds: path.nodeIds, pathEdgeIds: path.edgeIds };
    });
  const uniqueSpans = spans.filter((span, index) => (
    Boolean(span.nodeId) && spans.findIndex((item) => item.nodeId === span.nodeId) === index
  ));
  const edgeIds = [...new Set(uniqueSpans.flatMap((span) => span.pathEdgeIds ?? []))];
  for (let index = 1; index < uniqueSpans.length; index += 1) {
    const source = uniqueSpans[index - 1].nodeId;
    const target = uniqueSpans[index].nodeId;
    const edge = analysis.edges.find((item) => item.source === source && item.target === target)
      ?? analysis.edges.find((item) => item.source === target && item.target === source);
    if (edge && !edgeIds.includes(edge.id)) edgeIds.push(edge.id);
  }

  const tracedNodeIds = [...new Set(uniqueSpans.flatMap((span) => span.pathNodeIds ?? (span.nodeId ? [span.nodeId] : [])))];
  const steps = tracedNodeIds.flatMap((nodeId) => {
    const node = analysis.nodes.find((item) => item.id === nodeId);
    if (!node) return [];
    const sourceSpan = uniqueSpans.find((span) => span.pathNodeIds?.includes(nodeId) || span.nodeId === nodeId);
    const incomingEdge = edgeIds.find((edgeId) => analysis.edges.find((edge) => edge.id === edgeId && edge.target === node.id));
    return [{
      nodeId,
      ...(incomingEdge ? { edgeId: incomingEdge } : {}),
      role: roleForNode(node.kind),
      label: node.label,
      detail: sourceSpan
        ? `${sourceSpan.serviceName} · ${formatDuration(sourceSpan.durationMs)} · ${sourceSpan.matchReason ?? 'runtime span'}`
        : 'Контекст runtime span',
    }];
  });
  const failureSpan = spans.find((span) => span.status === 'error' || span.events.some((event) => event.name === 'exception'));
  const failureMessage = failureSpan ? exceptionValue(failureSpan, 'exception.message') ?? failureSpan.statusMessage : undefined;
  const routeSpan = spans.find((span) => typeof span.attributes['http.route'] === 'string');
  const routeNode = routeSpan?.nodeId ? analysis.nodes.find((node) => node.id === routeSpan.nodeId) : undefined;
  const routePattern = routeSpan?.attributes['http.route'];
  const routeMethod = routeSpan?.attributes['http.request.method'] ?? routeSpan?.attributes['http.method'];

  const trace: RequestTrace = {
    ...(routeNode && typeof routePattern === 'string' ? {
      matchedRoute: {
        nodeId: routeNode.id,
        method: typeof routeMethod === 'string' ? routeMethod : 'HTTP',
        pattern: routePattern,
        line: numericAttribute(routeSpan, 'code.line.number'),
      },
    } : {}),
    steps,
    nodeIds: steps.map((step) => step.nodeId),
    edgeIds,
    ...(failureSpan ? {
      probableFailure: {
        ...(failureSpan.nodeId ? { nodeId: failureSpan.nodeId } : {}),
        confidence: failureSpan.nodeId ? 'high' as const : 'medium' as const,
        title: failureMessage ?? `Ошибка в span «${failureSpan.name}»`,
        reason: failureLocation(failureSpan),
        evidence: [
          `trace ${failureSpan.traceId.slice(0, 12)}… · span ${failureSpan.spanId}`,
          `сервис ${failureSpan.serviceName} · ${formatDuration(failureSpan.durationMs)}`,
          ...(failureSpan.statusMessage && failureSpan.statusMessage !== failureMessage ? [failureSpan.statusMessage] : []),
        ],
      },
    } : {}),
  };
  return { session, spans, trace };
}

function hierarchyPath(analysis: ProjectAnalysis, nodeId: string): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds = [nodeId];
  const edgeIds: string[] = [];
  const visited = new Set(nodeIds);
  let current = nodeId;
  while (true) {
    const edge = analysis.edges.find((item) => item.kind === 'contains' && item.target === current && !visited.has(item.source));
    if (!edge) break;
    const parent = analysis.nodes.find((node) => node.id === edge.source);
    if (!parent) break;
    if (parent.kind !== 'project') nodeIds.unshift(parent.id);
    edgeIds.unshift(edge.id);
    visited.add(parent.id);
    current = parent.id;
  }
  return { nodeIds, edgeIds };
}

function matchSpan(nodes: AtlasNode[], span: RuntimeSpan): Pick<MappedRuntimeSpan, 'nodeId' | 'matchReason'> {
  const explicitId = span.attributes['code.atlas.node.id'];
  if (typeof explicitId === 'string' && nodes.some((node) => node.id === explicitId)) {
    return { nodeId: explicitId, matchReason: 'точный node.id' };
  }

  const filePath = stringAttribute(span, 'code.file.path') ?? stringAttribute(span, 'code.filepath');
  const functionName = stringAttribute(span, 'code.function.name') ?? stringAttribute(span, 'code.function');
  const namespace = stringAttribute(span, 'code.namespace');
  const route = stringAttribute(span, 'http.route');
  const dbSystem = stringAttribute(span, 'db.system');
  const terms = [functionName, namespace, span.name, route].filter((value): value is string => Boolean(value));
  let best: { node: AtlasNode; score: number; reason: string } | undefined;

  for (const node of nodes) {
    let score = 0;
    const reasons: string[] = [];
    if (filePath && node.path && samePathTail(filePath, node.path)) {
      score += 70;
      reasons.push('файл');
    }
    if (functionName && nodeMatchesTerm(node, functionName)) {
      score += 55;
      reasons.push('функция');
    }
    if (route && node.members?.some((member) => member.kind === 'route' && member.name.includes(route))) {
      score += 65;
      reasons.push('route');
    }
    if (dbSystem && node.kind === 'database' && normalize(node.label).includes(normalize(dbSystem))) {
      score += 80;
      reasons.push('БД');
    }
    if (node.kind === 'service' && normalize(node.label) === normalize(span.serviceName)) {
      score += 45;
      reasons.push('service.name');
    }
    if (terms.some((term) => normalize(node.label) === normalize(lastNamePart(term)))) {
      score += 35;
      reasons.push('имя span');
    }
    if (score > (best?.score ?? 0)) best = { node, score, reason: reasons.join(' + ') };
  }
  return best && best.score >= 35 ? { nodeId: best.node.id, matchReason: best.reason } : {};
}

function nodeMatchesTerm(node: AtlasNode, term: string): boolean {
  const normalized = normalize(lastNamePart(term));
  return normalize(node.label) === normalized
    || Boolean(node.members?.some((member) => normalize(member.name) === normalized));
}

function samePathTail(left: string, right: string): boolean {
  const normalizedLeft = left.replaceAll('\\', '/').toLowerCase();
  const normalizedRight = right.replaceAll('\\', '/').toLowerCase();
  return normalizedLeft.endsWith(normalizedRight) || normalizedRight.endsWith(normalizedLeft);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
}

function lastNamePart(value: string): string {
  return value.split(/[.#/:]/).filter(Boolean).at(-1) ?? value;
}

function roleForNode(kind: NodeKind): RequestTraceRole {
  if (kind === 'service') return 'service';
  if (kind === 'controller') return 'controller';
  if (kind === 'function') return 'function';
  if (kind === 'database') return 'dependency';
  if (kind === 'class') return 'repository';
  return 'handler';
}

function compareSpans(left: RuntimeSpan, right: RuntimeSpan): number {
  try {
    const delta = BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano);
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  } catch {
    return left.startTimeUnixNano.localeCompare(right.startTimeUnixNano);
  }
}

function failureLocation(span: RuntimeSpan): string {
  const file = stringAttribute(span, 'code.file.path') ?? stringAttribute(span, 'code.filepath');
  const line = numericAttribute(span, 'code.line.number');
  const method = stringAttribute(span, 'code.function.name') ?? span.name;
  if (file) return `${file}${line ? `:${line}` : ''} · ${method}`;
  return `${span.serviceName} · ${method}`;
}

function exceptionValue(span: RuntimeSpan, key: string): string | undefined {
  for (const event of span.events) {
    const value = event.attributes[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function stringAttribute(span: RuntimeSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function numericAttribute(span: RuntimeSpan | undefined, key: string): number | undefined {
  if (!span) return undefined;
  const value = span.attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1 ? `${Math.round(milliseconds * 1_000)} µs` : `${milliseconds.toFixed(milliseconds < 10 ? 2 : 1)} ms`;
}
