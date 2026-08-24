import type { NodeKind, ProjectSummary } from '../../shared/graph';

interface ProjectSidebarProps {
  summary: ProjectSummary;
  visibleKinds: Set<NodeKind>;
  onToggleKind: (kind: NodeKind) => void;
}

const FILTERS: Array<{ kind: NodeKind; label: string }> = [
  { kind: 'service', label: 'Сервисы' },
  { kind: 'database', label: 'Базы данных' },
  { kind: 'module', label: 'Модули' },
  { kind: 'controller', label: 'Контроллеры' },
  { kind: 'class', label: 'Классы' },
  { kind: 'interface', label: 'Интерфейсы' },
  { kind: 'function', label: 'Функции' },
];

export function ProjectSidebar({ summary, visibleKinds, onToggleKind }: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar">
      <section>
        <p className="eyebrow">Обзор проекта</p>
        <h1>{summary.name}</h1>
        <p className="root-path" title={summary.rootPath}>{summary.rootPath}</p>
      </section>

      <section className="stat-grid">
        <article><strong>{summary.services}</strong><span>сервисов</span></article>
        <article><strong>{summary.modules}</strong><span>модулей</span></article>
        <article><strong>{summary.symbols}</strong><span>символов</span></article>
        <article><strong>{summary.filesScanned}</strong><span>файлов</span></article>
      </section>

      <section className="sidebar-section">
        <div className="section-heading"><h2>Языки</h2><span>{summary.languages.length}</span></div>
        <div className="language-list">
          {summary.languages.slice(0, 6).map((language) => (
            <div className="language-row" key={language.name}>
              <div><span className={`language-dot language-dot--${language.name.toLowerCase().replace(/[^a-z]+/g, '-')}`} />{language.name}</div>
              <div className="language-bar"><i style={{ width: `${language.percentage}%` }} /></div>
              <span>{language.percentage}%</span>
            </div>
          ))}
        </div>
      </section>

      {summary.technologies.length ? (
        <section className="sidebar-section">
          <h2>Технологии</h2>
          <div className="tag-list">{summary.technologies.map((item) => <span key={item}>{item}</span>)}</div>
        </section>
      ) : null}

      <section className="sidebar-section filters">
        <h2>Слои карты</h2>
        {FILTERS.map((filter) => (
          <label key={filter.kind}>
            <input
              type="checkbox"
              checked={visibleKinds.has(filter.kind)}
              onChange={() => onToggleKind(filter.kind)}
            />
            <span className={`kind-dot kind-dot--${filter.kind}`} />
            {filter.label}
          </label>
        ))}
      </section>

      <footer>
        <span className="status-dot" />
        Снимок за {summary.durationMs} мс
      </footer>
    </aside>
  );
}
