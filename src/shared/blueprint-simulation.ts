import type { ArchitectureBlueprintDraft, BlueprintBehavior, BlueprintEdge, BlueprintNode } from './blueprint.js';

export interface BlueprintSimulationStep {
  nodeId: string;
  nodeLabel: string;
  status: 'success' | 'failed';
  input: unknown;
  output?: unknown;
  message: string;
  durationMs: number;
  viaEdgeId?: string;
}

export interface BlueprintSimulationResult {
  status: 'completed' | 'failed';
  startedAt: string;
  entryNodeId: string;
  nodeIds: string[];
  edgeIds: string[];
  steps: BlueprintSimulationStep[];
  output?: unknown;
}

interface QueueItem {
  nodeId: string;
  input: unknown;
  viaEdgeId?: string;
}

export function simulateBlueprint(
  document: ArchitectureBlueprintDraft,
  entryNodeId: string,
  payload: unknown,
): BlueprintSimulationResult {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(entryNodeId)) throw new Error('Стартовый компонент не найден.');
  const outgoing = new Map<string, BlueprintEdge[]>();
  for (const edge of document.edges) {
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }

  const queue: QueueItem[] = [{ nodeId: entryNodeId, input: payload }];
  const visited = new Set<string>();
  const steps: BlueprintSimulationStep[] = [];
  let output: unknown = payload;
  let failed = false;

  while (queue.length > 0 && steps.length < document.nodes.length) {
    const current = queue.shift()!;
    if (visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    const node = nodeById.get(current.nodeId);
    if (!node) continue;
    const execution = executeBehavior(node, current.input);
    const step: BlueprintSimulationStep = {
      nodeId: node.id,
      nodeLabel: node.label,
      status: execution.failed ? 'failed' : 'success',
      input: current.input,
      ...(execution.failed ? {} : { output: execution.output }),
      message: execution.message,
      durationMs: execution.durationMs,
      ...(current.viaEdgeId ? { viaEdgeId: current.viaEdgeId } : {}),
    };
    steps.push(step);
    if (execution.failed) {
      failed = true;
      continue;
    }
    output = execution.output;
    for (const edge of outgoing.get(node.id) ?? []) {
      queue.push({ nodeId: edge.target, input: execution.output, viaEdgeId: edge.id });
    }
  }

  return {
    status: failed ? 'failed' : 'completed',
    startedAt: new Date().toISOString(),
    entryNodeId,
    nodeIds: steps.map((step) => step.nodeId),
    edgeIds: steps.flatMap((step) => step.viaEdgeId ? [step.viaEdgeId] : []),
    steps,
    ...(failed ? {} : { output }),
  };
}

function executeBehavior(node: BlueprintNode, input: unknown): {
  output?: unknown;
  failed: boolean;
  message: string;
  durationMs: number;
} {
  const behavior: BlueprintBehavior = node.behavior ?? { kind: 'pass' };
  const durationMs = behavior.kind === 'delay' ? behavior.delayMs ?? 250 : estimatedDuration(node);
  if (behavior.kind === 'fail') {
    return { failed: true, message: behavior.config?.trim() || 'Компонент завершил выполнение с ошибкой.', durationMs };
  }
  if (behavior.kind === 'validate') {
    const fields = (behavior.config ?? '').split(',').map((field) => field.trim()).filter(Boolean);
    const record = isRecord(input) ? input : {};
    const missing = fields.filter((field) => !(field in record));
    if (missing.length > 0) {
      return { failed: true, message: `Не пройдена проверка: нет полей ${missing.join(', ')}.`, durationMs };
    }
    return { output: input, failed: false, message: fields.length ? `Проверены поля: ${fields.join(', ')}.` : 'Входные данные приняты.', durationMs };
  }
  if (behavior.kind === 'transform') {
    const addition = parseConfig(behavior.config, {});
    const output = isRecord(input) && isRecord(addition) ? { ...input, ...addition } : addition;
    return { output, failed: false, message: 'Данные преобразованы и переданы дальше.', durationMs };
  }
  if (behavior.kind === 'respond') {
    return { output: parseConfig(behavior.config, { ok: true }), failed: false, message: 'Сформирован ответ компонента.', durationMs };
  }
  if (behavior.kind === 'delay') {
    return { output: input, failed: false, message: `Смоделирована задержка ${durationMs} мс.`, durationMs };
  }
  return { output: input, failed: false, message: defaultMessage(node), durationMs };
}

function parseConfig(value: string | undefined, fallback: unknown): unknown {
  if (!value?.trim()) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value };
  }
}

function defaultMessage(node: BlueprintNode): string {
  if (node.kind === 'database') return 'Смоделирована операция с базой данных.';
  if (node.kind === 'cache') return 'Смоделировано обращение к кэшу.';
  if (node.kind === 'queue') return 'Событие помещено в очередь.';
  if (node.kind === 'external') return 'Получен mock-ответ внешней системы.';
  return 'Данные переданы без изменений.';
}

function estimatedDuration(node: BlueprintNode): number {
  if (node.kind === 'database' || node.kind === 'external') return 80;
  if (node.kind === 'queue') return 25;
  if (node.kind === 'cache') return 8;
  return 15;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
