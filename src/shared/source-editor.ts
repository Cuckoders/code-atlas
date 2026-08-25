export const SOURCE_EDITORS = ['vscode', 'cursor', 'system', 'simple'] as const;

export type SourceEditor = typeof SOURCE_EDITORS[number];

export interface OpenSourceRequest {
  projectPath: string;
  filePath: string;
  editor: SourceEditor;
  line?: number;
  column?: number;
}

export interface OpenSourceResult {
  opened: true;
  editor: SourceEditor;
}
