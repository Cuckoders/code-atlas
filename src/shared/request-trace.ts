import type { AtlasEdge, AtlasNode, ProjectAnalysis, ProjectDiagnostic, SymbolMember } from './graph.js';

export const REQUEST_PROBE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export type RequestProbeMethod = typeof REQUEST_PROBE_METHODS[number];
export type RequestProbeErrorKind = 'timeout' | 'connection' | 'tls' | 'network';
export type RequestTraceRole = 'service' | 'route' | 'handler' | 'controller' | 'function' | 'repository' | 'dependency';
export type RequestTraceConfidence = 'low' | 'medium' | 'high';

export interface RequestProbeInput {
  method: RequestProbeMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RequestProbeResult {
  id: string;
  method: RequestProbeMethod;
  url: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  status?: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseTruncated: boolean;
  error?: {
    kind: RequestProbeErrorKind;
    message: string;
  };
}

export interface RequestTraceStep {
  nodeId: string;
  edgeId?: string;
  role: RequestTraceRole;
  label: string;
  detail?: string;
}

export interface RequestTraceFailure {
  nodeId?: string;
  confidence: RequestTraceConfidence;
  title: string;
  reason: string;
  evidence: string[];
}

export interface RequestTrace {
  matchedRoute?: {
    nodeId: string;
    method: string;
    pattern: string;
    line?: number;
  };
  steps: RequestTraceStep[];
  nodeIds: string[];
  edgeIds: string[];
  probableFailure?: RequestTraceFailure;
}

interface RouteCandidate {
  owner: AtlasNode;
  member: SymbolMember;
  method: string;
  pattern: string;
  score: number;
}

export function traceProjectRequest(
  analysis: ProjectAnalysis,
  input: RequestProbeInput,
  probe: RequestProbeResult,
): RequestTrace {
  const requestPath = requestPathname(input.url);
  const blueprintRuntimeTrace = traceBlueprintRuntimeResponse(analysis, probe);
  if (blueprintRuntimeTrace) return blueprintRuntimeTrace;
  const route = requestPath ? findRoute(analysis.nodes, input.method, requestPath) : undefined;
  if (!route) {
    return {
      steps: [],
      nodeIds: [],
      edgeIds: [],
      probableFailure: inferUnmappedFailure(probe, input.method, requestPath),
    };
  }

  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const steps: RequestTraceStep[] = [];
  const seenNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const ancestors = buildAncestorChain(route.owner.id, analysis.edges, nodeById);
  const service = ancestors.find((item) => item.node.kind === 'service');

  if (service) addStep(steps, seenNodeIds, edgeIds, service.node, 'service', service.edge?.id, service.node.path);
  addStep(
    steps,
    seenNodeIds,
    edgeIds,
    route.owner,
    'route',
    service ? findEdgeId(analysis.edges, service.node.id, route.owner.id, 'contains') : undefined,
    `${route.method} ${route.pattern}${route.member.line ? ` · строка ${route.member.line}` : ''}`,
  );

  const handler = findRouteHandler(route, analysis.nodes, analysis.edges, nodeById);
  if (handler) {
    addStep(
      steps,
      seenNodeIds,
      edgeIds,
      handler,
      'handler',
      findEdgeId(analysis.edges, route.owner.id, handler.id, 'contains'),
      handler.path,
    );
    appendCallGraph(handler.id, analysis.edges, nodeById, steps, seenNodeIds, edgeIds);
  }

  if (service) {
    for (const dependencyEdge of analysis.edges
      .filter((edge) => edge.kind === 'uses' && edge.source === service.node.id)
      .sort((left, right) => left.target.localeCompare(right.target))) {
      const dependency = nodeById.get(dependencyEdge.target);
      if (dependency) addStep(steps, seenNodeIds, edgeIds, dependency, 'dependency', dependencyEdge.id, 'Инфраструктурная зависимость сервиса');
    }
  }

  const probableFailure = inferMappedFailure(probe, route, steps, analysis.diagnostics, nodeById);
  return {
    matchedRoute: {
      nodeId: route.owner.id,
      method: route.method,
      pattern: route.pattern,
      line: route.member.line,
    },
    steps,
    nodeIds: steps.map((step) => step.nodeId),
    edgeIds: [...edgeIds],
    probableFailure,
  };
}

interface BlueprintRuntimeResponseStep {
  nodeLabel: string;
  nodeKind?: string;
  status: 'success' | 'failed';
  durationMs?: number;
  error?: string;
}

function traceBlueprintRuntimeResponse(analysis: ProjectAnalysis, probe: RequestProbeResult): RequestTrace | undefined {
  if (!probe.responseBody.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.responseBody);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps) || (parsed.status !== 'completed' && parsed.status !== 'failed')) return undefined;
  const runtimeSteps = parsed.steps.flatMap((value): BlueprintRuntimeResponseStep[] => {
    if (!isRecord(value) || typeof value.nodeLabel !== 'string' || (value.status !== 'success' && value.status !== 'failed')) return [];
    return [{
      nodeLabel: value.nodeLabel,
      status: value.status,
      ...(typeof value.nodeKind === 'string' ? { nodeKind: value.nodeKind } : {}),
      ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    }];
  });
  if (!runtimeSteps.length) return undefined;

  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const steps: RequestTraceStep[] = [];
  const seenNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  let lastMappedNode: AtlasNode | undefined;
  let failureNode: AtlasNode | undefined;
  let failedRuntimeStep: BlueprintRuntimeResponseStep | undefined;

  for (const runtimeStep of runtimeSteps) {
    const mapped = matchBlueprintRuntimeNode(analysis.nodes, runtimeStep);
    if (mapped) {
      for (const ancestor of buildAncestorChain(mapped.id, analysis.edges, nodeById)) {
        if (ancestor.node.kind === 'project') continue;
        addStep(steps, seenNodeIds, edgeIds, ancestor.node, roleForNode(ancestor.node), ancestor.edge?.id, 'Контекст Blueprint runtime');
      }
      const incoming = analysis.edges.find((edge) => edge.kind === 'contains' && edge.target === mapped.id);
      addStep(
        steps,
        seenNodeIds,
        edgeIds,
        mapped,
        roleForNode(mapped),
        incoming?.id,
        `${runtimeStep.nodeLabel} · ${Math.max(0, runtimeStep.durationMs ?? 0)} мс`,
      );
      lastMappedNode = mapped;
    }
    if (runtimeStep.status === 'failed' && !failedRuntimeStep) {
      failedRuntimeStep = runtimeStep;
      failureNode = mapped ?? lastMappedNode;
    }
  }

  const probableFailure = failedRuntimeStep || (probe.status ?? 0) >= 500 ? {
    ...(failureNode ? { nodeId: failureNode.id } : {}),
    confidence: failureNode ? 'high' as const : 'medium' as const,
    title: failedRuntimeStep?.error || `Blueprint runtime: HTTP ${probe.status ?? 500}`,
    reason: failureNode
      ? `Runtime зафиксировал падение на шаге «${failedRuntimeStep?.nodeLabel ?? failureNode.label}»; на карте выделен связанный код «${failureNode.label}».`
      : `Runtime зафиксировал падение на шаге «${failedRuntimeStep?.nodeLabel ?? 'неизвестный компонент'}», но связанный код отсутствует в текущем снимке.`,
    evidence: compactEvidence([
      `${probe.method} ${requestPathname(probe.url) ?? probe.url}`,
      `${probe.status ?? 500} ${probe.statusText ?? ''}`.trim(),
      failedRuntimeStep ? `Шаг: ${failedRuntimeStep.nodeLabel}` : '',
    ]),
  } : undefined;

  return {
    steps,
    nodeIds: [...seenNodeIds],
    edgeIds: [...edgeIds],
    ...(probableFailure ? { probableFailure } : {}),
  };
}

function matchBlueprintRuntimeNode(nodes: AtlasNode[], step: BlueprintRuntimeResponseStep): AtlasNode | undefined {
  const runtimeName = normalizeRuntimeName(step.nodeLabel);
  let best: { node: AtlasNode; score: number } | undefined;
  for (const node of nodes) {
    if (node.kind === 'project') continue;
    const nodeName = normalizeRuntimeName(node.label);
    const fileName = normalizeRuntimeName(node.path?.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, '') ?? '');
    let score = 0;
    if (nodeName === runtimeName) score += 100;
    else if (nodeName.includes(runtimeName) || runtimeName.includes(nodeName)) score += 62;
    if (fileName === runtimeName) score += 80;
    else if (fileName.includes(runtimeName) || runtimeName.includes(fileName)) score += 55;
    if (node.kind !== 'module' && node.kind !== 'service') score += 8;
    if (step.nodeKind === 'controller' && (node.kind === 'controller' || node.kind === 'function')) score += 12;
    if (step.nodeKind === 'service' && (node.kind === 'class' || node.kind === 'controller')) score += 10;
    if (score > (best?.score ?? 0)) best = { node, score };
  }
  return best && best.score >= 62 ? best.node : undefined;
}

function normalizeRuntimeName(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
}

function findRoute(nodes: AtlasNode[], method: RequestProbeMethod, pathname: string): RouteCandidate | undefined {
  const candidates: RouteCandidate[] = [];
  for (const node of nodes) {
    for (const member of node.members ?? []) {
      if (member.kind !== 'route') continue;
      const parsed = /^([A-Za-z*]+)\s+(.+)$/.exec(member.name.trim());
      if (!parsed) continue;
      const routeMethod = parsed[1].toUpperCase();
      if (routeMethod !== method && routeMethod !== 'ANY' && routeMethod !== 'ROUTE' && routeMethod !== '*') continue;
      const pattern = parsed[2].trim();
      const score = routeMatchScore(pattern, pathname);
      if (score < 0) continue;
      candidates.push({ owner: node, member, method: routeMethod, pattern, score });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.owner.id.localeCompare(right.owner.id))[0];
}

function routeMatchScore(pattern: string, pathname: string): number {
  const patternSegments = pathSegments(pattern);
  const requestSegments = pathSegments(pathname);
  let score = 0;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === '*' || segment === '**') return score + 1;
    const actual = requestSegments[index];
    if (actual === undefined) return -1;
    if (isDynamicSegment(segment)) {
      score += 3;
    } else if (safeDecode(segment) === safeDecode(actual)) {
      score += 12;
    } else {
      return -1;
    }
  }
  if (requestSegments.length !== patternSegments.length) return -1;
  return score + patternSegments.length;
}

function pathSegments(value: string): string[] {
  const pathname = value.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '');
  return pathname ? pathname.split('/') : [];
}

function isDynamicSegment(segment: string): boolean {
  return /^:[A-Za-z_]/.test(segment)
    || /^\{[^}]+\}$/.test(segment)
    || /^<[^>]+>$/.test(segment)
    || /^\[[^\]]+\]$/.test(segment);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requestPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function buildAncestorChain(
  nodeId: string,
  edges: AtlasEdge[],
  nodeById: Map<string, AtlasNode>,
): Array<{ node: AtlasNode; edge?: AtlasEdge }> {
  const result: Array<{ node: AtlasNode; edge?: AtlasEdge }> = [];
  const visited = new Set([nodeId]);
  let current = nodeId;
  while (true) {
    const parentEdge = edges.find((edge) => edge.kind === 'contains' && edge.target === current && !visited.has(edge.source));
    if (!parentEdge) break;
    const parent = nodeById.get(parentEdge.source);
    if (!parent) break;
    result.push({ node: parent, edge: parentEdge });
    visited.add(parent.id);
    current = parent.id;
  }
  return result.reverse();
}

function findRouteHandler(
  route: RouteCandidate,
  nodes: AtlasNode[],
  edges: AtlasEdge[],
  nodeById: Map<string, AtlasNode>,
): AtlasNode | undefined {
  const children = edges
    .filter((edge) => edge.kind === 'contains' && edge.source === route.owner.id)
    .map((edge) => nodeById.get(edge.target))
    .filter((node): node is AtlasNode => Boolean(node));
  const routeLine = route.member.line ?? Number.POSITIVE_INFINITY;
  return children
    .filter((node) => node.kind === 'function' || node.kind === 'controller' || node.kind === 'class')
    .map((node) => ({ node, line: Number(node.metadata?.line ?? 0) }))
    .filter((item) => item.line <= routeLine)
    .sort((left, right) => right.line - left.line || handlerPriority(right.node) - handlerPriority(left.node))[0]?.node
    ?? nodes.find((node) => node.path === route.owner.path && node.kind === 'function');
}

function handlerPriority(node: AtlasNode): number {
  return node.kind === 'function' ? 3 : node.kind === 'controller' ? 2 : 1;
}

function appendCallGraph(
  startNodeId: string,
  edges: AtlasEdge[],
  nodeById: Map<string, AtlasNode>,
  steps: RequestTraceStep[],
  seenNodeIds: Set<string>,
  edgeIds: Set<string>,
): void {
  const callsBySource = new Map<string, AtlasEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    const current = callsBySource.get(edge.source) ?? [];
    current.push(edge);
    callsBySource.set(edge.source, current);
  }
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];
  const expanded = new Set<string>();
  while (queue.length > 0 && steps.length < 14) {
    const current = queue.shift();
    if (!current || current.depth >= 4 || expanded.has(current.nodeId)) continue;
    expanded.add(current.nodeId);
    const outgoing = [...(callsBySource.get(current.nodeId) ?? [])].sort((left, right) => left.target.localeCompare(right.target));
    for (const edge of outgoing) {
      const target = nodeById.get(edge.target);
      if (!target) continue;
      addStep(steps, seenNodeIds, edgeIds, target, roleForNode(target), edge.id, edge.label);
      queue.push({ nodeId: target.id, depth: current.depth + 1 });
    }
  }
}

function roleForNode(node: AtlasNode): RequestTraceRole {
  if (node.kind === 'controller') return 'controller';
  if (node.kind === 'function') return 'function';
  if (node.kind === 'database') return 'dependency';
  if (/repository|repo|dao|store/i.test(node.label)) return 'repository';
  return 'function';
}

function addStep(
  steps: RequestTraceStep[],
  seenNodeIds: Set<string>,
  edgeIds: Set<string>,
  node: AtlasNode,
  role: RequestTraceRole,
  edgeId?: string,
  detail?: string,
): void {
  if (edgeId) edgeIds.add(edgeId);
  if (seenNodeIds.has(node.id)) return;
  seenNodeIds.add(node.id);
  steps.push({ nodeId: node.id, edgeId, role, label: node.label, detail });
}

function findEdgeId(edges: AtlasEdge[], source: string, target: string, kind: AtlasEdge['kind']): string | undefined {
  return edges.find((edge) => edge.source === source && edge.target === target && edge.kind === kind)?.id;
}

function inferUnmappedFailure(
  probe: RequestProbeResult,
  method: RequestProbeMethod,
  pathname?: string,
): RequestTraceFailure | undefined {
  if (probe.error) {
    return {
      confidence: probe.error.kind === 'connection' ? 'high' : 'medium',
      title: probe.error.kind === 'timeout' ? 'Таймаут до входа в известный маршрут' : 'Сервис недоступен',
      reason: probe.error.message,
      evidence: [`${method} ${pathname ?? probe.url}`, 'Маршрут не найден в текущем статическом снимке.'],
    };
  }
  if ((probe.status ?? 0) >= 400) {
    return {
      confidence: probe.status === 404 ? 'high' : 'low',
      title: probe.status === 404 ? 'Маршрут не найден' : `HTTP ${probe.status}`,
      reason: 'Ответ с ошибкой получен, но endpoint не сопоставился с route текущей карты.',
      evidence: [`${method} ${pathname ?? probe.url}`, `${probe.status} ${probe.statusText ?? ''}`.trim()],
    };
  }
  return undefined;
}

function inferMappedFailure(
  probe: RequestProbeResult,
  route: RouteCandidate,
  steps: RequestTraceStep[],
  diagnostics: ProjectDiagnostic[],
  nodeById: Map<string, AtlasNode>,
): RequestTraceFailure | undefined {
  const serviceStep = steps.find((step) => step.role === 'service');
  const handlerStep = steps.find((step) => step.role === 'handler') ?? steps.find((step) => step.role === 'route');
  const riskCandidate = highestRiskStep(steps, diagnostics, nodeById);
  const responseHint = findResponseHintStep(probe.responseBody, steps, nodeById);

  if (probe.error) {
    const timedOut = probe.error.kind === 'timeout';
    const target = timedOut ? riskCandidate?.step ?? steps.at(-1) : serviceStep ?? handlerStep;
    return {
      nodeId: target?.nodeId,
      confidence: timedOut ? (riskCandidate ? 'medium' : 'low') : 'high',
      title: timedOut ? 'Вероятная точка таймаута' : 'Сервис недоступен',
      reason: timedOut
        ? `Запрос превысил лимит времени; наиболее рискованный доступный узел — ${target?.label ?? route.owner.label}.`
        : probe.error.message,
      evidence: compactEvidence([probe.error.message, ...(riskCandidate?.evidence ?? [])]),
    };
  }

  const status = probe.status ?? 0;
  if (status >= 500) {
    const target = responseHint?.step ?? riskCandidate?.step ?? [...steps].reverse().find((step) => step.role !== 'dependency') ?? handlerStep;
    return {
      nodeId: target?.nodeId,
      confidence: responseHint || riskCandidate ? 'medium' : 'low',
      title: `Вероятная точка HTTP ${status}`,
      reason: `Сервис вернул ${status}; статический граф указывает на ${target?.label ?? route.owner.label}, но точное исключение требует runtime trace.`,
      evidence: compactEvidence([
        `${status} ${probe.statusText ?? ''}`.trim(),
        ...(responseHint?.evidence ?? []),
        ...(riskCandidate && riskCandidate.step.nodeId === target?.nodeId ? riskCandidate.evidence : []),
      ]),
    };
  }
  if (status >= 400) {
    return {
      nodeId: handlerStep?.nodeId ?? route.owner.id,
      confidence: status === 404 || status === 405 ? 'medium' : 'low',
      title: status === 404 ? 'Маршрут отклонён сервисом' : `Запрос отклонён: HTTP ${status}`,
      reason: 'Ошибка 4xx обычно возникает при маршрутизации, авторизации или валидации до основной бизнес-логики.',
      evidence: [`${route.method} ${route.pattern}`, `${status} ${probe.statusText ?? ''}`.trim()],
    };
  }
  if (riskCandidate && riskCandidate.score >= 5) {
    return {
      nodeId: riskCandidate.step.nodeId,
      confidence: 'low',
      title: 'Наиболее рискованный участок пути',
      reason: `Запрос успешен; ${riskCandidate.step.label} выделен как возможная будущая точка отказа по статическому анализу.`,
      evidence: riskCandidate.evidence,
    };
  }
  return undefined;
}

function highestRiskStep(
  steps: RequestTraceStep[],
  diagnostics: ProjectDiagnostic[],
  nodeById: Map<string, AtlasNode>,
): { step: RequestTraceStep; score: number; evidence: string[] } | undefined {
  const candidates = steps.map((step, index) => {
    const nodeDiagnostics = diagnostics.filter((diagnostic) => diagnostic.nodeIds.includes(step.nodeId));
    const node = nodeById.get(step.nodeId);
    const diagnosticScore = Math.max(0, ...nodeDiagnostics.map((diagnostic) => (
      diagnostic.severity === 'error' ? 10 : diagnostic.severity === 'warning' ? 5 : 1
    )));
    const churn = Number(node?.metadata?.gitChurn ?? 0);
    const hotspotScore = Math.min(4, Math.floor(churn / 100));
    return {
      step,
      index,
      rolePriority: riskRolePriority(step.role),
      score: diagnosticScore + hotspotScore,
      evidence: compactEvidence([
        ...nodeDiagnostics.slice(0, 3).map((diagnostic) => diagnostic.title),
        churn >= 100 ? `Git churn: ${churn} строк` : '',
      ]),
    };
  }).filter((candidate) => candidate.score > 0);
  return candidates.sort((left, right) => (
    right.score - left.score || right.rolePriority - left.rolePriority || left.index - right.index
  ))[0];
}

function riskRolePriority(role: RequestTraceRole): number {
  if (role === 'dependency') return 4;
  if (role === 'repository') return 3;
  if (role === 'controller' || role === 'handler') return 2;
  if (role === 'function' || role === 'route') return 1;
  return 0;
}

function findResponseHintStep(
  responseBody: string,
  steps: RequestTraceStep[],
  nodeById: Map<string, AtlasNode>,
): { step: RequestTraceStep; evidence: string[] } | undefined {
  const normalized = responseBody.slice(0, 4096).toLowerCase();
  if (!normalized) return undefined;

  const dependencySteps = steps.filter((step) => step.role === 'dependency');
  for (const step of [...dependencySteps, ...steps.filter((item) => item.role === 'repository')]) {
    const node = nodeById.get(step.nodeId);
    const terms = compactEvidence([
      step.label.toLowerCase(),
      node?.kind === 'database' && /postgres/i.test(step.label) ? 'postgres' : '',
      node?.kind === 'database' && /mysql|maria/i.test(step.label) ? 'mysql' : '',
      node?.kind === 'database' && /mongo/i.test(step.label) ? 'mongo' : '',
      node?.kind === 'database' && /elastic/i.test(step.label) ? 'elastic' : '',
      step.role === 'repository' ? 'repository' : '',
    ]);
    const term = terms.find((candidate) => candidate.length >= 4 && normalized.includes(candidate));
    if (term) return { step, evidence: [`Ответ содержит указание на «${term}».`] };
  }

  if (/\b(database|db|sql|база данных)\b/i.test(normalized) && dependencySteps.length > 0) {
    return { step: dependencySteps[0], evidence: ['Ответ содержит указание на базу данных.'] };
  }
  return undefined;
}

function compactEvidence(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
