export const BLUEPRINT_VERSION = 1 as const;
export const MAX_BLUEPRINT_NODES = 200;
export const MAX_BLUEPRINT_EDGES = 400;
export const MAX_BLUEPRINT_JSON_SIZE = 256 * 1024;

export const BLUEPRINT_NODE_KINDS = [
  'system',
  'service',
  'frontend',
  'gateway',
  'controller',
  'module',
  'component',
  'class',
  'abstract-class',
  'interface',
  'database',
  'cache',
  'queue',
  'external',
] as const;

export const BLUEPRINT_EDGE_KINDS = [
  'http',
  'grpc',
  'event',
  'reads',
  'writes',
  'depends',
  'implements',
  'extends',
  'creates',
  'calls',
] as const;
export const BLUEPRINT_NODE_STATUSES = ['planned', 'approved', 'implemented'] as const;

export type BlueprintNodeKind = (typeof BLUEPRINT_NODE_KINDS)[number];
export type BlueprintEdgeKind = (typeof BLUEPRINT_EDGE_KINDS)[number];
export type BlueprintNodeStatus = (typeof BLUEPRINT_NODE_STATUSES)[number];

export interface BlueprintNode {
  id: string;
  label: string;
  kind: BlueprintNodeKind;
  position: { x: number; y: number };
  status: BlueprintNodeStatus;
  technology?: string;
  language?: string;
  owner?: string;
  actualNodeId?: string;
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  kind: BlueprintEdgeKind;
  label?: string;
}

export interface ArchitectureBlueprintDraft {
  version: typeof BLUEPRINT_VERSION;
  projectPath: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

export interface ArchitectureBlueprint extends ArchitectureBlueprintDraft {
  updatedAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateArchitectureBlueprint(input: unknown, requireUpdatedAt = false): string | null {
  if (!isRecord(input)) return 'Blueprint должен быть объектом.';
  if (input.version !== BLUEPRINT_VERSION) return 'Версия blueprint не поддерживается.';
  if (!isText(input.projectPath, 4_096, true)) return 'Некорректный путь проекта.';
  if (!Array.isArray(input.nodes) || input.nodes.length > MAX_BLUEPRINT_NODES) {
    return `Blueprint может содержать не более ${MAX_BLUEPRINT_NODES} узлов.`;
  }
  if (!Array.isArray(input.edges) || input.edges.length > MAX_BLUEPRINT_EDGES) {
    return `Blueprint может содержать не более ${MAX_BLUEPRINT_EDGES} связей.`;
  }
  if (requireUpdatedAt && (typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt)))) {
    return 'Некорректная дата обновления blueprint.';
  }

  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !UUID_PATTERN.test(node.id)) return 'Некорректный ID узла.';
    if (nodeIds.has(node.id)) return 'ID узлов должны быть уникальными.';
    nodeIds.add(node.id);
    if (!isText(node.label, 128, true)) return 'Название узла должно содержать от 1 до 128 символов.';
    if (!BLUEPRINT_NODE_KINDS.includes(node.kind as BlueprintNodeKind)) return 'Неизвестный тип узла.';
    if (!BLUEPRINT_NODE_STATUSES.includes(node.status as BlueprintNodeStatus)) return 'Неизвестный статус узла.';
    if (!isRecord(node.position)
      || !isCoordinate(node.position.x)
      || !isCoordinate(node.position.y)) return 'Некорректная позиция узла.';
    for (const field of ['technology', 'language', 'owner'] as const) {
      if (node[field] !== undefined && !isText(node[field], 128, false)) return `Некорректное поле ${field}.`;
    }
    if (node.actualNodeId !== undefined && !isText(node.actualNodeId, 1_024, true)) {
      return 'Некорректная связь с фактическим узлом.';
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (!isRecord(edge) || typeof edge.id !== 'string' || !UUID_PATTERN.test(edge.id)) return 'Некорректный ID связи.';
    if (edgeIds.has(edge.id)) return 'ID связей должны быть уникальными.';
    edgeIds.add(edge.id);
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string'
      || !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) {
      return 'Связь должна соединять два существующих разных узла.';
    }
    if (!BLUEPRINT_EDGE_KINDS.includes(edge.kind as BlueprintEdgeKind)) return 'Неизвестный тип связи.';
    if (edge.label !== undefined && !isText(edge.label, 128, false)) return 'Некорректная подпись связи.';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength: number, required: boolean): value is string {
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) return false;
  return required ? value.trim().length > 0 : true;
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
}
