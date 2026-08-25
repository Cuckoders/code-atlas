import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlueprintCodegenError, generateBlueprintCode } from '../src/server/blueprint-codegen.js';
import type { ArchitectureBlueprintDraft } from '../src/shared/blueprint.js';

function createBlueprint(projectPath: string): ArchitectureBlueprintDraft {
  return {
    version: 1,
    projectPath,
    nodes: [
      {
        id: '123e4567-e89b-42d3-a456-426614174001',
        label: 'Order API',
        kind: 'controller',
        status: 'planned',
        position: { x: 0, y: 0 },
        language: 'TypeScript',
        behavior: { kind: 'validate', config: 'orderId' },
        codegen: { enabled: true, template: 'http-handler' },
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174002',
        label: 'Order Service',
        kind: 'service',
        status: 'planned',
        position: { x: 220, y: 0 },
        language: 'TypeScript',
        behavior: { kind: 'transform', config: '{"accepted":true}' },
        codegen: { enabled: true, template: 'service' },
      },
    ],
    edges: [{
      id: '123e4567-e89b-42d3-a456-426614174003',
      source: '123e4567-e89b-42d3-a456-426614174001',
      target: '123e4567-e89b-42d3-a456-426614174002',
      kind: 'calls',
    }],
  };
}

describe('blueprint code generation', () => {
  it('creates safe scaffold files once and never overwrites them', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-codegen-'));
    try {
      const request = {
        projectPath,
        blueprintName: 'Order flow',
        outputDirectory: 'generated/order-flow',
        blueprint: createBlueprint(projectPath),
      };
      const first = await generateBlueprintCode(request);
      const second = await generateBlueprintCode(request);

      expect(first.created).toEqual(expect.arrayContaining([
        'generated/order-flow/order-api.ts',
        'generated/order-flow/order-service.ts',
        'generated/order-flow/blueprint.generated.json',
      ]));
      expect(second.created).toEqual([]);
      expect(second.skipped).toEqual(first.created);
      await expect(fs.readFile(path.join(projectPath, 'generated/order-flow/order-api.ts'), 'utf8'))
        .resolves.toContain('orderAPIHandler');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the project and symlinked output folders', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-codegen-safe-'));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-codegen-outside-'));
    try {
      const blueprint = createBlueprint(projectPath);
      await expect(generateBlueprintCode({ projectPath, blueprintName: 'Unsafe', outputDirectory: '../outside', blueprint }))
        .rejects.toBeInstanceOf(BlueprintCodegenError);
      await fs.symlink(outsidePath, path.join(projectPath, 'linked'));
      await expect(generateBlueprintCode({ projectPath, blueprintName: 'Unsafe', outputDirectory: 'linked/output', blueprint }))
        .rejects.toBeInstanceOf(BlueprintCodegenError);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });
});
