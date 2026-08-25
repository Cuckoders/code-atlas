import { useMemo, useState } from 'react';
import type { ArchitectureBlueprintDraft } from '../../shared/blueprint';
import type { BlueprintCodegenResult } from '../../shared/blueprint-codegen';
import { apiFetch } from '../desktop';

interface BlueprintCodegenPanelProps {
  projectPath: string;
  blueprintName: string;
  document: ArchitectureBlueprintDraft;
  onClose: () => void;
}

export default function BlueprintCodegenPanel({ projectPath, blueprintName, document, onClose }: BlueprintCodegenPanelProps) {
  const defaultDirectory = useMemo(() => `code-atlas-generated/${slug(blueprintName) || 'blueprint'}`, [blueprintName]);
  const [outputDirectory, setOutputDirectory] = useState(defaultDirectory);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<BlueprintCodegenResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch('/api/blueprints/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath, blueprintName, outputDirectory, blueprint: document }),
      });
      const payload = await response.json() as BlueprintCodegenResult | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось сгенерировать код.');
      setResult(payload);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : 'Не удалось сгенерировать код.');
    } finally {
      setGenerating(false);
    }
  };

  const enabledCount = document.nodes.filter((node) => (
    (node.codegen?.enabled !== false && !['system', 'database', 'cache', 'queue', 'external'].includes(node.kind))
    || node.codegen?.enabled === true
  )).length;

  return (
    <aside className="blueprint-tool-panel blueprint-codegen-panel" aria-label="Генерация кода blueprint">
      <header><div><span>Scaffold</span><h2>Генерация кода</h2></div><button type="button" aria-label="Закрыть генерацию кода" onClick={onClose}>×</button></header>
      <p>Будут созданы только новые файлы. Существующий код не перезаписывается.</p>
      <label><span>Папка внутри проекта</span><input name="blueprint-output-directory" maxLength={512} pattern="[A-Za-z0-9._/\\-]+" value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} /></label>
      <div className="blueprint-codegen-summary"><strong>{enabledCount}</strong><span>компонентов подготовлено к генерации</span></div>
      <button type="button" className="blueprint-tool-panel__primary" disabled={generating || !outputDirectory.trim() || enabledCount === 0} onClick={() => void generate()}>{generating ? 'Генерируем…' : '⌘ Сгенерировать шаблоны'}</button>
      {error ? <p className="blueprint-tool-panel__error" role="alert">{error}</p> : null}
      {result ? <section className="blueprint-codegen-result" aria-live="polite"><strong>Готово</strong><span>{result.outputDirectory}</span><div><i>＋ {result.created.length} создано</i><i>↷ {result.skipped.length} пропущено</i></div>{result.created.length ? <ul>{result.created.map((file) => <li key={file}>{file}</li>)}</ul> : null}</section> : null}
    </aside>
  );
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64);
}
