import type { AtlasEdge, AtlasNode } from '../shared/graph';

export type GraphLayoutMode = 'services' | 'layers';

export interface GraphZone {
  id: string;
  kind: 'service' | 'layer';
  title: string;
  subtitle: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  nodeIds: string[];
}

export interface AtlasGraphLayout {
  positions: Map<string, { x: number; y: number }>;
  zones: GraphZone[];
}

const NODE_HEIGHT = 88;
const SERVICE_COLUMNS = { service: 350, module: 640, symbol: 930, data: 1_480 } as const;
const SYMBOL_COLUMN_GAP = 250;
const LAYER_COLUMNS = [40, 370, 700, 1_030, 1_360, 1_690] as const;
const LAYER_TITLES = [
  ['Project', 'Корень проекта'],
  ['Services', 'Границы приложений'],
  ['Endpoints', 'Routes и модули'],
  ['Handlers', 'Контроллеры и функции'],
  ['Domain', 'Классы и интерфейсы'],
  ['Data', 'Repositories и инфраструктура'],
] as const;

export function layoutAtlasGraph(
  nodes: AtlasNode[],
  edges: AtlasEdge[],
  mode: GraphLayoutMode,
  hierarchyNodes: AtlasNode[] = nodes,
  hierarchyEdges: AtlasEdge[] = edges,
): AtlasGraphLayout {
  return mode === 'layers' ? createLayerLayout(nodes) : createServiceLayout(nodes, hierarchyNodes, hierarchyEdges);
}

function createServiceLayout(nodes: AtlasNode[], hierarchyNodes: AtlasNode[], hierarchyEdges: AtlasEdge[]): AtlasGraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const zones: GraphZone[] = [];
  const nodeById = new Map(hierarchyNodes.map((node) => [node.id, node]));
  const parentById = new Map(
    hierarchyEdges.filter((edge) => edge.kind === 'contains').map((edge) => [edge.target, edge.source]),
  );
  const visibleIds = new Set(nodes.map((node) => node.id));
  const services = hierarchyNodes.filter((node) => node.kind === 'service');
  const serviceByNodeId = new Map<string, string>();

  for (const node of nodes) {
    const serviceId = findServiceOwner(node.id, parentById, nodeById);
    if (serviceId) serviceByNodeId.set(node.id, serviceId);
  }

  let laneTop = 0;
  for (const service of services) {
    const owned = nodes.filter((node) => serviceByNodeId.get(node.id) === service.id && node.id !== service.id);
    if (!visibleIds.has(service.id) && owned.length === 0) continue;
    const modules = owned.filter((node) => node.kind === 'module' || hasRoutes(node));
    const moduleIds = new Set(modules.map((node) => node.id));
    const symbols = owned.filter((node) => !moduleIds.has(node.id));
    const rows = Math.max(1, modules.length, Math.ceil(symbols.length / 2));
    const height = Math.max(220, 98 + rows * NODE_HEIGHT);
    const zoneNodeIds = [service.id, ...owned.map((node) => node.id)];

    zones.push({
      id: `zone:service:${service.id}`,
      kind: 'service',
      title: service.label,
      subtitle: `${modules.length} модулей · ${symbols.length} символов`,
      position: { x: SERVICE_COLUMNS.service - 40, y: laneTop },
      width: 1_120,
      height,
      nodeIds: zoneNodeIds,
    });
    if (visibleIds.has(service.id)) positions.set(service.id, { x: SERVICE_COLUMNS.service, y: laneTop + 68 });
    modules.forEach((node, index) => positions.set(node.id, { x: SERVICE_COLUMNS.module, y: laneTop + 68 + index * NODE_HEIGHT }));
    symbols.forEach((node, index) => positions.set(node.id, {
      x: SERVICE_COLUMNS.symbol + (index % 2) * SYMBOL_COLUMN_GAP,
      y: laneTop + 68 + Math.floor(index / 2) * NODE_HEIGHT,
    }));
    laneTop += height + 30;
  }

  const unowned = nodes.filter((node) => !positions.has(node.id) && node.kind !== 'project' && node.kind !== 'database');
  unowned.forEach((node, index) => positions.set(node.id, { x: SERVICE_COLUMNS.module, y: laneTop + index * NODE_HEIGHT }));
  const databases = nodes.filter((node) => node.kind === 'database');
  databases.forEach((node, index) => positions.set(node.id, { x: SERVICE_COLUMNS.data, y: 90 + index * 138 }));
  const project = nodes.find((node) => node.kind === 'project');
  if (project) positions.set(project.id, { x: 0, y: Math.max(80, laneTop / 2 - 40) });

  return { positions, zones };
}

function createLayerLayout(nodes: AtlasNode[]): AtlasGraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const nodesByLayer = Array.from({ length: LAYER_COLUMNS.length }, () => [] as AtlasNode[]);
  for (const node of nodes) nodesByLayer[layerIndex(node)].push(node);
  const maxRows = Math.max(1, ...nodesByLayer.map((items) => items.length));
  const height = 116 + maxRows * NODE_HEIGHT;
  const zones: GraphZone[] = nodesByLayer.map((layerNodes, index) => ({
    id: `zone:layer:${index}`,
    kind: 'layer',
    title: LAYER_TITLES[index][0],
    subtitle: `${LAYER_TITLES[index][1]} · ${layerNodes.length}`,
    position: { x: LAYER_COLUMNS[index] - 28, y: 0 },
    width: 282,
    height,
    nodeIds: layerNodes.map((node) => node.id),
  }));

  nodesByLayer.forEach((layerNodes, layer) => {
    layerNodes.forEach((node, index) => positions.set(node.id, {
      x: LAYER_COLUMNS[layer],
      y: 70 + index * NODE_HEIGHT,
    }));
  });
  return { positions, zones };
}

function findServiceOwner(
  nodeId: string,
  parentById: Map<string, string>,
  nodeById: Map<string, AtlasNode>,
): string | undefined {
  const visited = new Set<string>();
  let currentId: string | undefined = nodeId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    if (nodeById.get(currentId)?.kind === 'service') return currentId;
    currentId = parentById.get(currentId);
  }
  return undefined;
}

function layerIndex(node: AtlasNode): number {
  if (node.kind === 'project') return 0;
  if (node.kind === 'service') return 1;
  if (node.kind === 'database' || /repository|repo|dao|store/i.test(node.label)) return 5;
  if (node.kind === 'module' || hasRoutes(node)) return 2;
  if (node.kind === 'controller' || node.kind === 'function') return 3;
  return 4;
}

function hasRoutes(node: AtlasNode): boolean {
  return Boolean(node.members?.some((member) => member.kind === 'route'));
}
