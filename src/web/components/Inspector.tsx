import type { AtlasNode, NodeKind, ProjectDiagnostic } from '../../shared/graph';

interface InspectorProps {
  node: AtlasNode | null;
  onClose: () => void;
  canDive: boolean;
  onDive: () => void;
  diagnostics: ProjectDiagnostic[];
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

export function Inspector({ node, onClose, canDive, onDive, diagnostics }: InspectorProps) {
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

          {node.members?.length ? (
            <section className="inspector__section">
              <div className="section-heading">
                <h3>Структура</h3>
                <span>{node.members.length}</span>
              </div>
              <div className="member-list">
                {node.members.map((member, index) => (
                  <div className="member" key={`${member.name}-${index}`}>
                    <span className={`member__kind member__kind--${member.kind}`}>{member.kind === 'method' ? 'M' : member.kind === 'route' ? '↗' : 'P'}</span>
                    <div>
                      <strong>{member.signature ?? member.name}</strong>
                      <small>{member.kind}{member.line ? ` · строка ${member.line}` : ''}</small>
                    </div>
                  </div>
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
