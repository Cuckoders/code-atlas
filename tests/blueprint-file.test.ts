import { describe, expect, it } from 'vitest';
import { blueprintFileName, parseBlueprintFile, serializeBlueprintFile } from '../src/shared/blueprint-file.js';
import type { ArchitectureBlueprintDraft } from '../src/shared/blueprint.js';

const blueprint: ArchitectureBlueprintDraft = {
  version: 1,
  projectPath: '/projects/portable',
  nodes: [{
    id: '123e4567-e89b-42d3-a456-426614174001',
    label: 'Orders API',
    kind: 'controller',
    position: { x: 120, y: 80 },
    status: 'approved',
    behavior: { kind: 'validate', config: 'orderId' },
    codegen: { enabled: true, template: 'http-handler' },
  }],
  edges: [],
};

describe('Blueprint files', () => {
  it('round-trips a portable Blueprint envelope', () => {
    const opened = parseBlueprintFile(serializeBlueprintFile('Orders architecture', blueprint));
    expect(opened).toEqual({ name: 'Orders architecture', blueprint });
  });

  it('opens a raw Blueprint and derives its name from the file', () => {
    expect(parseBlueprintFile(JSON.stringify(blueprint), 'payments.code-atlas-blueprint.json')).toEqual({
      name: 'payments',
      blueprint,
    });
  });

  it('rejects malformed files and creates a portable file name', () => {
    expect(() => parseBlueprintFile('{broken')).toThrow('некорректный JSON');
    expect(blueprintFileName('Orders / Windows:*')).toBe('Orders - Windows-.code-atlas-blueprint.json');
  });
});
