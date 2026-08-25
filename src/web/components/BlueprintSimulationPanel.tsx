import { useEffect, useState } from 'react';
import type { ArchitectureBlueprintDraft } from '../../shared/blueprint';
import { simulateBlueprint, type BlueprintSimulationResult } from '../../shared/blueprint-simulation';

interface BlueprintSimulationPanelProps {
  document: ArchitectureBlueprintDraft;
  result: BlueprintSimulationResult | null;
  activeStep: number;
  onResult: (result: BlueprintSimulationResult) => void;
  onSelectStep: (index: number) => void;
  onClose: () => void;
  mode?: 'combined' | 'request' | 'trace';
  onModeChange?: (mode: 'request' | 'trace') => void;
}

export default function BlueprintSimulationPanel({
  document,
  result,
  activeStep,
  onResult,
  onSelectStep,
  onClose,
  mode = 'combined',
  onModeChange,
}: BlueprintSimulationPanelProps) {
  const incoming = new Set(document.edges.map((edge) => edge.target));
  const defaultEntry = document.nodes.find((node) => !incoming.has(node.id))?.id ?? document.nodes[0]?.id ?? '';
  const [entryNodeId, setEntryNodeId] = useState(defaultEntry);
  const [payload, setPayload] = useState('{"requestId":"demo-1","amount":100}');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!document.nodes.some((node) => node.id === entryNodeId)) setEntryNodeId(defaultEntry);
  }, [defaultEntry, document.nodes, entryNodeId]);

  const run = () => {
    setError(null);
    try {
      const parsed = payload.trim() ? JSON.parse(payload) as unknown : {};
      onResult(simulateBlueprint(document, entryNodeId, parsed));
    } catch (runError) {
      setError(runError instanceof SyntaxError ? 'Входные данные должны быть корректным JSON.' : runError instanceof Error ? runError.message : 'Не удалось запустить симуляцию.');
    }
  };

  return (
    <aside className="blueprint-tool-panel blueprint-simulation-panel" aria-label="Симуляция blueprint">
      <header><div><span>Runtime preview</span><h2>Симуляция</h2></div><button type="button" aria-label="Закрыть симуляцию" onClick={onClose}>×</button></header>
      {mode !== 'combined' ? (
        <nav className="blueprint-runtime-tabs" aria-label="Режим Blueprint runtime">
          <button type="button" className={mode === 'request' ? 'is-active' : ''} onClick={() => onModeChange?.('request')}>↗ Запрос</button>
          <button type="button" className={mode === 'trace' ? 'is-active' : ''} onClick={() => onModeChange?.('trace')}>⌁ Трейс</button>
        </nav>
      ) : null}
      {mode !== 'trace' ? (
        <>
          <label><span>Стартовый компонент</span><select value={entryNodeId} onChange={(event) => setEntryNodeId(event.target.value)}>{document.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
          <label><span>Входные данные JSON</span><textarea name="blueprint-simulation-input" rows={5} value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} /></label>
          <button type="button" className="blueprint-tool-panel__primary" disabled={!entryNodeId} onClick={run}>▶ Отправить запрос</button>
          {error ? <p className="blueprint-tool-panel__error" role="alert">{error}</p> : null}
        </>
      ) : null}
      {mode !== 'request' && result ? (
        <section className="blueprint-simulation-result">
          <div><strong className={`is-${result.status}`}>{result.status === 'completed' ? 'Выполнено' : 'Есть ошибка'}</strong><span>{result.steps.length} шагов</span></div>
          <ol>{result.steps.map((step, index) => (
            <li className={`${index === activeStep ? 'is-active' : ''} is-${step.status}`} key={`${step.nodeId}:${index}`}>
              <button type="button" onClick={() => onSelectStep(index)}><i>{index + 1}</i><span><strong>{step.nodeLabel}</strong><small>{step.message}</small></span><em>{step.durationMs} мс</em></button>
            </li>
          ))}</ol>
          {result.output !== undefined ? <details><summary>Результат</summary><pre>{JSON.stringify(result.output, null, 2)}</pre></details> : null}
        </section>
      ) : mode === 'trace' ? <div className="blueprint-runtime-empty"><strong>Трейсов пока нет</strong><span>Отправьте запрос или выполните быстрый запуск.</span></div> : null}
    </aside>
  );
}
