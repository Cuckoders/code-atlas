import {
  validateArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
} from './blueprint.js';

export const BLUEPRINT_FILE_FORMAT = 'code-atlas-blueprint' as const;
export const BLUEPRINT_FILE_EXTENSION = '.code-atlas-blueprint.json';
export const MAX_BLUEPRINT_FILE_SIZE = 300 * 1024;

interface BlueprintFileEnvelope {
  format: typeof BLUEPRINT_FILE_FORMAT;
  exportedAt: string;
  name: string;
  blueprint: ArchitectureBlueprintDraft;
}

export interface OpenedBlueprintFile {
  name: string;
  blueprint: ArchitectureBlueprintDraft;
}

export function serializeBlueprintFile(name: string, blueprint: ArchitectureBlueprintDraft): string {
  const envelope: BlueprintFileEnvelope = {
    format: BLUEPRINT_FILE_FORMAT,
    exportedAt: new Date().toISOString(),
    name: name.trim() || 'Blueprint',
    blueprint,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseBlueprintFile(contents: string, fallbackName = 'Blueprint'): OpenedBlueprintFile {
  if (new TextEncoder().encode(contents).byteLength > MAX_BLUEPRINT_FILE_SIZE) {
    throw new Error('Файл Blueprint слишком большой.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Файл Blueprint содержит некорректный JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Файл Blueprint должен содержать объект.');

  const candidate = isRecord(parsed.blueprint) ? parsed.blueprint : parsed;
  const validationError = validateArchitectureBlueprint(candidate, false);
  if (validationError) throw new Error(validationError);

  const name = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : fallbackName.replace(/\.code-atlas-blueprint\.json$/i, '').replace(/\.json$/i, '') || 'Blueprint';
  const blueprint = candidate as unknown as ArchitectureBlueprintDraft;
  return {
    name,
    blueprint: {
      version: blueprint.version,
      projectPath: blueprint.projectPath,
      nodes: blueprint.nodes,
      edges: blueprint.edges,
    },
  };
}

export function blueprintFileName(name: string): string {
  const safeName = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/g, '').slice(0, 100);
  return `${safeName || 'blueprint'}${BLUEPRINT_FILE_EXTENSION}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
