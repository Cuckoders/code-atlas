import type { ArchitectureBlueprintDraft } from './blueprint.js';

export interface BlueprintCodegenRequest {
  projectPath: string;
  blueprintName: string;
  outputDirectory: string;
  blueprint: ArchitectureBlueprintDraft;
}

export interface BlueprintCodegenResult {
  outputDirectory: string;
  created: string[];
  skipped: string[];
}
