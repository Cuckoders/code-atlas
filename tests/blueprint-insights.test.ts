import { describe, expect, it } from 'vitest';
import type { BlueprintEdge, BlueprintNode } from '../src/shared/blueprint.js';
import type { AtlasNode } from '../src/shared/graph.js';
import { calculateBlueprintImpact, findBlueprintMatchSuggestions } from '../src/web/blueprint-insights.js';

describe('blueprint insights', () => {
  it('suggests an actual node by canonical name and compatible kind', () => {
    const blueprint = blueprintNode('Catalog Service', 'service', 1);
    const actual: AtlasNode[] = [
      { id: 'service:catalog', label: 'catalog', kind: 'service', language: 'TypeScript' },
      { id: 'module:catalog', label: 'catalog', kind: 'module', language: 'TypeScript' },
    ];
    expect(findBlueprintMatchSuggestions(blueprint, actual, new Set())).toEqual([
      expect.objectContaining({ node: actual[0], score: 85, reasons: ['совпадает основа имени', 'совместимый тип'] }),
      expect.objectContaining({ node: actual[1], score: 60 }),
    ]);
  });

  it('calculates transitive dependents as blast radius', () => {
    const nodes = [
      blueprintNode('API', 'service', 1),
      blueprintNode('Orders', 'service', 2),
      blueprintNode('Repository', 'interface', 3),
      blueprintNode('Database', 'database', 4),
    ];
    const edges: BlueprintEdge[] = [
      blueprintEdge(nodes[0], nodes[1], 5),
      blueprintEdge(nodes[1], nodes[2], 6),
      blueprintEdge(nodes[2], nodes[3], 7),
    ];
    const impact = calculateBlueprintImpact(nodes[3].id, nodes, edges);
    expect(impact.directDependents.map((node) => node.label)).toEqual(['Repository']);
    expect(impact.affected.map((node) => node.label)).toEqual(['Repository', 'Orders', 'API']);
    expect(impact.level).toBe('medium');
  });
});

function blueprintNode(label: string, kind: BlueprintNode['kind'], value: number): BlueprintNode {
  return { id: uuid(value), label, kind, position: { x: 0, y: 0 }, status: 'planned' };
}

function blueprintEdge(source: BlueprintNode, target: BlueprintNode, value: number): BlueprintEdge {
  return { id: uuid(value), source: source.id, target: target.id, kind: 'depends' };
}

function uuid(value: number): string {
  return `123e4567-e89b-42d3-a456-${value.toString(16).padStart(12, '0')}`;
}
