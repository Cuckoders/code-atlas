import { useEffect, useState } from 'react';
import type { AtlasNode, NodeKind, NodeStructureDiff, ProjectDiagnostic, SourceDiffLine, SymbolMember } from '../../shared/graph';
import type { SourceEditor } from '../../shared/source-editor';
import { sourceLocationForNode } from '../source-editor';

interface InspectorProps {
  node: AtlasNode | null;
  onClose: () => void;
  canDive: boolean;
  onDive: () => void;
  diagnostics: ProjectDiagnostic[];
  sourceEditor: SourceEditor;
  onSourceEditorChange: (editor: SourceEditor) => void;
  onOpenSource: (node: AtlasNode, line?: number) => Promise<void>;
}

const KIND_LABELS: Record<NodeKind, string> = {
  project: 'Проект',
  service: 'Сервис',
  database: 'База данных',
  module: 'Модуль',
  controller: 'Контроллер',
  class: 'Класс',
  interface: 'Интерфейс',
  function: 'Функция',
};

export function Inspector({
  node,
  onClose,
  canDive,
  onDive,
  diagnostics,
  sourceEditor,
  onSourceEditorChange,
  onOpenSource,
}: InspectorProps) {
  const [openingLine, setOpeningLine] = useState<number | 'node' | null>(null);
  const [openStatus, setOpenStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const sourceLocation = node ? sourceLocationForNode(node) : null;

  useEffect(() => {
    setOpeningLine(null);
    setOpenStatus(null);
  }, [node?.id]);

  const openSource = async (line?: number) => {
    if (!node || !sourceLocation) return;
    setOpeningLine(line ?? 'node');
    setOpenStatus(null);
    try {
      await onOpenSource(node, line);
      setOpenStatus({ kind: 'success', message: `Открыто в ${EDITOR_LABELS[sourceEditor]}.` });
    } catch (error) {
      setOpenStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Не удалось открыть исходник.' });
    } finally {
      setOpeningLine(null);
    }
  };

  return (
    <aside className={`inspector ${node ? 'inspector--open' : ''}`} aria-hidden={!node}>
      {node ? (
        <>
          <div className="inspector__topline">
            <span className={`kind-dot kind-dot--${node.kind}`} />
            <span>{KIND_LABELS[node.kind]}</span>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть инспектор">×</button>
          </div>
          <h2>{node.label}</h2>
          {node.path ? <code className="path-chip">{node.path}</code> : null}
          {sourceLocation ? (
            <section className="source-editor-launcher">
              <label>
                <span>Редактор</span>
                <select
                  name="source-editor"
                  value={sourceEditor}
                  onChange={(event) => onSourceEditorChange(event.target.value as SourceEditor)}
                >
                  <option value="vscode">VS Code</option>
                  <option value="cursor">Cursor</option>
                  <option value="system">Системное приложение</option>
                  <option value="simple">Notepad / TextEdit</option>
                </select>
              </label>
              <button type="button" aria-busy={openingLine === 'node'} disabled={openingLine !== null} onClick={() => void openSource()}>
                <span aria-hidden="true">↗</span>
                {openingLine === 'node' ? 'Открываем…' : node.kind === 'project' ? 'Открыть папку проекта' : 'Открыть исходник'}
              </button>
              <small>Двойной клик открывает конечный блок. Для контейнера: Ctrl/Cmd + двойной клик.</small>
              <p className={openStatus ? `is-${openStatus.kind}` : ''} aria-live="polite">{openStatus?.message ?? ''}</p>
            </section>
          ) : null}
          {canDive ? (
            <button type="button" className="dive-button" onClick={onDive}>
              Открыть этот уровень <span>→</span>
            </button>
          ) : null}
          {node.language ? (
            <div className="detail-row"><span>Язык</span><strong>{node.language}</strong></div>
          ) : null}
          {node.subtitle ? (
            <div className="detail-row"><span>Тип</span><strong>{node.subtitle}</strong></div>
          ) : null}

          {diagnostics.length ? (
            <section className="inspector__section">
              <div className="section-heading"><h3>Диагностика</h3><span>{diagnostics.length}</span></div>
              <div className="inspector-diagnostics">
                {diagnostics.map((diagnostic) => (
                  <article className={`diagnostic-card diagnostic-card--${diagnostic.severity}`} key={diagnostic.id}>
                    <strong>{diagnostic.title}</strong>
                    <p>{diagnostic.message}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {node.structureDiff ? <StructureDiff diff={node.structureDiff} /> : null}

          {node.members?.length ? (
            <section className="inspector__section">
              <div className="section-heading">
                <h3>Структура</h3>
                <span>{node.members.length}</span>
              </div>
              <div className="member-list">
                {node.members.map((member, index) => (
                  <button
                    type="button"
                    className="member"
                    disabled={!sourceLocation || !member.line || openingLine !== null}
                    key={`${member.name}-${index}`}
                    onClick={() => void openSource(member.line)}
                    title={member.line ? `Открыть строку ${member.line} в ${EDITOR_LABELS[sourceEditor]}` : undefined}
                  >
                    <span className={`member__kind member__kind--${member.kind}`}>{member.kind === 'method' ? 'M' : member.kind === 'route' ? '↗' : 'P'}</span>
                    <div>
                      <strong>{member.signature ?? member.name}</strong>
                      <small>{member.kind}{member.line ? ` · строка ${member.line}` : ''}</small>
                    </div>
                    <i className="member__open" aria-hidden="true">{openingLine === member.line ? '…' : '↗'}</i>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {node.metadata && Object.keys(node.metadata).length ? (
            <section className="inspector__section">
              <h3>Метаданные</h3>
              {Object.entries(node.metadata).map(([key, value]) => (
                <div className="detail-row" key={key}>
                  <span>{key}</span>
                  <strong>{Array.isArray(value) ? value.join(', ') || '—' : String(value)}</strong>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

const EDITOR_LABELS: Record<SourceEditor, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  system: 'системном приложении',
  simple: 'простом редакторе',
};

function StructureDiff({ diff }: { diff: NodeStructureDiff }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  return (
    <section className="inspector__section structure-diff">
      <div className="section-heading"><h3>Изменения структуры</h3><span>{total}</span></div>
      <div className="structure-diff__list">
        {diff.added.map((member, index) => (
          <MemberDiffCard key={`added:${member.kind}:${member.name}:${index}`} status="added" member={member} />
        ))}
        {diff.removed.map((member, index) => (
          <MemberDiffCard key={`removed:${member.kind}:${member.name}:${index}`} status="removed" member={member} />
        ))}
        {diff.changed.map((change, index) => (
          <article className="member-diff member-diff--changed" key={`changed:${change.kind}:${change.name}:${index}`}>
            <span className="member-diff__status">~</span>
            <div>
              <strong>{change.name}</strong>
              <code className="member-diff__before">− {memberSignature(change.before)}</code>
              <code className="member-diff__after">+ {memberSignature(change.after)}</code>
              {change.sourceDiff ? <SourceDiff lines={change.sourceDiff} truncated={Boolean(change.before.sourceTruncated || change.after.sourceTruncated)} /> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MemberDiffCard({ status, member }: { status: 'added' | 'removed'; member: SymbolMember }) {
  return (
    <article className={`member-diff member-diff--${status}`}>
      <span className="member-diff__status">{status === 'added' ? '+' : '−'}</span>
      <div>
        <strong>{memberSignature(member)}</strong>
        <small>{status === 'added' ? 'Добавлено' : 'Удалено'} · {member.kind}</small>
        {member.source ? <SourceDiff lines={singleSourceDiff(member, status)} truncated={Boolean(member.sourceTruncated)} /> : null}
      </div>
    </article>
  );
}

function memberSignature(member: SymbolMember): string {
  return member.signature ?? member.name;
}

function SourceDiff({ lines, truncated }: { lines: SourceDiffLine[]; truncated: boolean }) {
  return (
    <details className="source-diff">
      <summary>Source diff <span>{lines.length} строк</span></summary>
      <div className="source-diff__code">
        {lines.map((line, index) => (
          <div className={`source-line source-line--${line.kind}`} key={`${line.kind}:${line.beforeLine ?? 0}:${line.afterLine ?? 0}:${index}`}>
            <span>{line.beforeLine ?? ''}</span>
            <span>{line.afterLine ?? ''}</span>
            <i>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</i>
            <code>{line.content || ' '}</code>
          </div>
        ))}
        {truncated ? <p className="source-diff__truncated">Фрагмент ограничен безопасным лимитом</p> : null}
      </div>
    </details>
  );
}

function singleSourceDiff(member: SymbolMember, status: 'added' | 'removed'): SourceDiffLine[] {
  return (member.source ?? '').split('\n').map((content, index) => ({
    kind: status,
    content,
    ...(status === 'added' ? { afterLine: index + 1 } : { beforeLine: index + 1 }),
  }));
}
