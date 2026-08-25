import { describe, expect, it } from 'vitest';
import type { ArchitectureBlueprintDraft } from '../src/shared/blueprint.js';
import { simulateBlueprint } from '../src/shared/blueprint-simulation.js';

const blueprint: ArchitectureBlueprintDraft = {
  version: 1,
  projectPath: '/tmp/demo',
  nodes: [
    {
      id: '123e4567-e89b-42d3-a456-426614174001',
      label: 'Validate order',
      kind: 'controller',
      status: 'planned',
      position: { x: 0, y: 0 },
      behavior: { kind: 'validate', config: 'orderId, amount' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174002',
      label: 'Enrich order',
      kind: 'service',
      status: 'planned',
      position: { x: 200, y: 0 },
      behavior: { kind: 'transform', config: '{"state":"accepted"}' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174003',
      label: 'Response',
      kind: 'controller',
      status: 'planned',
      position: { x: 400, y: 0 },
      behavior: { kind: 'respond', config: '{"ok":true}' },
    },
  ],
  edges: [
    { id: '123e4567-e89b-42d3-a456-426614174004', source: '123e4567-e89b-42d3-a456-426614174001', target: '123e4567-e89b-42d3-a456-426614174002', kind: 'calls' },
    { id: '123e4567-e89b-42d3-a456-426614174005', source: '123e4567-e89b-42d3-a456-426614174002', target: '123e4567-e89b-42d3-a456-426614174003', kind: 'calls' },
  ],
};

describe('blueprint simulation', () => {
  it('passes transformed data through the graph and returns a response', () => {
    const result = simulateBlueprint(blueprint, blueprint.nodes[0].id, { orderId: 'o-1', amount: 100 });

    expect(result.status).toBe('completed');
    expect(result.nodeIds).toEqual(blueprint.nodes.map((node) => node.id));
    expect(result.edgeIds).toEqual(blueprint.edges.map((edge) => edge.id));
    expect(result.steps[1].output).toEqual({ orderId: 'o-1', amount: 100, state: 'accepted' });
    expect(result.output).toEqual({ ok: true });
  });

  it('shows the probable failure node and does not continue along its outgoing edge', () => {
    const result = simulateBlueprint(blueprint, blueprint.nodes[0].id, { orderId: 'o-1' });

    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual(expect.objectContaining({
      nodeId: blueprint.nodes[0].id,
      status: 'failed',
      message: expect.stringContaining('amount'),
    }));
  });
});
