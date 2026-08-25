import { describe, expect, it } from 'vitest';
import type { AtlasEdge, AtlasNode } from '../src/shared/graph.js';
import { layoutAtlasGraph } from '../src/web/graph-layout.js';

const nodes: AtlasNode[] = [
  { id: 'project', label: 'shop', kind: 'project' },
  { id: 'api', label: 'api', kind: 'service' },
  { id: 'worker', label: 'worker', kind: 'service' },
  { id: 'route', label: 'products.ts', kind: 'module', members: [{ name: 'GET /products', kind: 'route' }] },
  { id: 'controller', label: 'ProductsController', kind: 'controller' },
  { id: 'repository', label: 'ProductRepository', kind: 'class' },
  { id: 'database', label: 'PostgreSQL', kind: 'database' },
];
const edges: AtlasEdge[] = [
  { id: 'project-api', source: 'project', target: 'api', kind: 'contains' },
  { id: 'project-worker', source: 'project', target: 'worker', kind: 'contains' },
  { id: 'api-route', source: 'api', target: 'route', kind: 'contains' },
  { id: 'route-controller', source: 'route', target: 'controller', kind: 'contains' },
  { id: 'route-repository', source: 'route', target: 'repository', kind: 'contains' },
];

describe('graph layouts', () => {
  it('creates separate service zones and keeps descendants inside their lane', () => {
    const layout = layoutAtlasGraph(nodes, edges, 'services');
    const apiZone = layout.zones.find((zone) => zone.title === 'api');

    expect(layout.zones.filter((zone) => zone.kind === 'service')).toHaveLength(2);
    expect(apiZone?.nodeIds).toEqual(expect.arrayContaining(['api', 'route', 'controller', 'repository']));
    expect(layout.positions.get('route')?.y).toBeGreaterThanOrEqual(apiZone?.position.y ?? 0);
    expect(layout.positions.get('database')?.x).toBeGreaterThan(layout.positions.get('repository')?.x ?? 0);
  });

  it('separates endpoint, handler, domain and data layers', () => {
    const layout = layoutAtlasGraph(nodes, edges, 'layers');

    expect(layout.zones.map((zone) => zone.title)).toEqual(['Project', 'Services', 'Endpoints', 'Handlers', 'Domain', 'Data']);
    expect(layout.positions.get('route')?.x).toBeLessThan(layout.positions.get('controller')?.x ?? 0);
    expect(layout.positions.get('controller')?.x).toBeLessThan(layout.positions.get('repository')?.x ?? 0);
    expect(layout.positions.get('repository')?.x).toBe(layout.positions.get('database')?.x);
  });

  it('keeps service ownership when an intermediate module is filtered out', () => {
    const visibleNodes = nodes.filter((node) => node.id === 'controller' || node.id === 'repository');
    const layout = layoutAtlasGraph(visibleNodes, [], 'services', nodes, edges);

    expect(layout.zones).toHaveLength(1);
    expect(layout.zones[0]).toEqual(expect.objectContaining({ title: 'api' }));
    expect(layout.zones[0].nodeIds).toEqual(expect.arrayContaining(['controller', 'repository']));
  });
});
