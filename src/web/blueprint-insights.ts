import type { BlueprintEdge, BlueprintNode, BlueprintNodeKind } from '../shared/blueprint';
import type { AtlasNode, NodeKind } from '../shared/graph';

export interface BlueprintMatchSuggestion {
  node: AtlasNode;
  score: number;
  reasons: string[];
}

export interface BlueprintImpact {
  directDependencies: BlueprintNode[];
  directDependents: BlueprintNode[];
  affected: BlueprintNode[];
  level: 'low' | 'medium' | 'high';
}

const GENERIC_SUFFIX = /(?:service|api|controller|module|repository|repo|adapter|gateway|interface|impl)$/;

export function findBlueprintMatchSuggestions(
  blueprintNode: BlueprintNode,
  actualNodes: AtlasNode[],
  matchedActualIds: Set<string>,
  limit = 3,
): BlueprintMatchSuggestion[] {
  const blueprintLabel = normalizeLabel(blueprintNode.label);
  const blueprintBase = canonicalLabel(blueprintLabel);
  const suggestions: BlueprintMatchSuggestion[] = [];

  for (const actual of actualNodes) {
    if (matchedActualIds.has(actual.id) && actual.id !== blueprintNode.actualNodeId) continue;
    const actualLabel = normalizeLabel(actual.label);
    const actualBase = canonicalLabel(actualLabel);
    let score = 0;
    const reasons: string[] = [];

    if (blueprintLabel === actualLabel) {
      score += 80;
      reasons.push('точное имя');
    } else if (blueprintBase.length >= 3 && blueprintBase === actualBase) {
      score += 60;
      reasons.push('совпадает основа имени');
    } else if (blueprintLabel.length >= 4 && (blueprintLabel.includes(actualLabel) || actualLabel.includes(blueprintLabel))) {
      score += 35;
      reasons.push('похожее имя');
    }

    if (isCompatibleKind(blueprintNode.kind, actual.kind)) {
      score += 25;
      reasons.push('совместимый тип');
    }
    if (blueprintNode.language && actual.language
      && normalizeLabel(blueprintNode.language) === normalizeLabel(actual.language)) {
      score += 10;
      reasons.push('тот же язык');
    }
    if (blueprintNode.technology && actual.subtitle
      && normalizeLabel(actual.subtitle).includes(normalizeLabel(blueprintNode.technology))) {
      score += 8;
      reasons.push('та же технология');
    }
    if (score >= 50) suggestions.push({ node: actual, score: Math.min(score, 100), reasons });
  }

  return suggestions.sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label)).slice(0, limit);
}

export function calculateBlueprintImpact(
  selectedId: string,
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
): BlueprintImpact {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const dependencyIds = new Set<string>();
  const dependentIds = new Set<string>();
  const reverse = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.source === selectedId) dependencyIds.add(edge.target);
    if (edge.target === selectedId) dependentIds.add(edge.source);
    const current = reverse.get(edge.target) ?? [];
    current.push(edge.source);
    reverse.set(edge.target, current);
  }

  const affectedIds = new Set<string>();
  const queue = [...(reverse.get(selectedId) ?? [])];
  while (queue.length > 0 && affectedIds.size < 200) {
    const current = queue.shift()!;
    if (current === selectedId || affectedIds.has(current)) continue;
    affectedIds.add(current);
    queue.push(...(reverse.get(current) ?? []));
  }

  const affected = [...affectedIds].flatMap((id) => nodeById.get(id) ?? []);
  return {
    directDependencies: [...dependencyIds].flatMap((id) => nodeById.get(id) ?? []),
    directDependents: [...dependentIds].flatMap((id) => nodeById.get(id) ?? []),
    affected,
    level: affected.length >= 6 ? 'high' : affected.length >= 2 ? 'medium' : 'low',
  };
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');
}

function canonicalLabel(value: string): string {
  const canonical = value.replace(GENERIC_SUFFIX, '');
  return canonical || value;
}

function isCompatibleKind(blueprintKind: BlueprintNodeKind, actualKind: NodeKind): boolean {
  if (blueprintKind === 'system') return actualKind === 'project';
  if (blueprintKind === 'service') return actualKind === 'service';
  if (blueprintKind === 'database' || blueprintKind === 'cache') return actualKind === 'database';
  if (blueprintKind === 'module') return actualKind === 'module';
  if (blueprintKind === 'controller') return actualKind === 'controller';
  if (blueprintKind === 'class' || blueprintKind === 'abstract-class') return actualKind === 'class';
  if (blueprintKind === 'interface') return actualKind === 'interface';
  if (blueprintKind === 'component') return actualKind === 'class' || actualKind === 'interface' || actualKind === 'function';
  return false;
}
