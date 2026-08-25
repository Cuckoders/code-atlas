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
  updated: string[];
  skipped: string[];
}

export interface BlueprintScaffoldRequest {
  blueprintName: string;
  blueprint: ArchitectureBlueprintDraft;
}

export interface BlueprintScaffoldFile {
  path: string;
  contents: string;
  overwrite: boolean;
}

export interface BlueprintScaffold {
  folderName: string;
  files: BlueprintScaffoldFile[];
}

export interface SavedBlueprintProject {
  folderName: string;
  written: string[];
  skipped: string[];
}

export type BlueprintProjectInspection =
  | { found: false }
  | { found: true; name: string; blueprint: ArchitectureBlueprintDraft };

export interface BlueprintRuntimeStatus {
  status: 'stopped' | 'running';
  projectPath: string;
  origin?: string;
  message?: string;
}
