import type { AtlasNode } from '../shared/graph';
import type { OpenSourceResult, SourceEditor } from '../shared/source-editor';
import { apiFetch } from './desktop';

export interface NodeSourceLocation {
  filePath: string;
  line?: number;
}

export function sourceLocationForNode(node: AtlasNode): NodeSourceLocation | null {
  const manifest = typeof node.metadata?.manifest === 'string' ? node.metadata.manifest : null;
  const filePath = manifest ?? node.path;
  if (!filePath) return null;
  const line = typeof node.metadata?.line === 'number' && Number.isInteger(node.metadata.line) && node.metadata.line > 0
    ? node.metadata.line
    : undefined;
  return { filePath, ...(line ? { line } : {}) };
}

export async function openNodeInEditor(
  projectPath: string,
  node: AtlasNode,
  editor: SourceEditor,
  lineOverride?: number,
): Promise<OpenSourceResult> {
  const location = sourceLocationForNode(node);
  if (!location) throw new Error('У этого блока нет связанного исходного файла.');
  const response = await apiFetch('/api/source/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      filePath: location.filePath,
      editor,
      line: lineOverride ?? location.line,
      column: 1,
    }),
  });
  const payload = await response.json() as OpenSourceResult | { error: string };
  if (!response.ok || 'error' in payload) {
    throw new Error('error' in payload ? payload.error : 'Не удалось открыть исходник.');
  }
  return payload;
}
