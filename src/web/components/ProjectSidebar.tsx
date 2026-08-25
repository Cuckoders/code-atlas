import { useState, type FormEvent } from 'react';
import type { ProjectSummary } from '../../shared/graph';
import type { ArchitectureBlueprintDraft } from '../../shared/blueprint';

interface ProjectSidebarProps {
  summary: ProjectSummary;
  onCompare: (reference: string) => void;
  loading: boolean;
  blueprint?: { id: string | null; name: string; document: ArchitectureBlueprintDraft } | null;
}

export function ProjectSidebar({
  summary,
  onCompare,
  loading,
  blueprint,
}: ProjectSidebarProps) {
  const [compareRef, setCompareRef] = useState('main');

  const handleCompare = (event: FormEvent) => {
    event.preventDefault();
    if (compareRef.trim()) onCompare(compareRef.trim());
  };

  return (
    <aside className="project-sidebar" id="project-sidebar" aria-label="Обзор проекта">
      <section>
        <p className="eyebrow">{blueprint ? 'Карта Blueprint' : 'Обзор проекта'}</p>
        <h1>{blueprint?.name ?? summary.name}</h1>
        <p className="root-path" title={blueprint?.document.projectPath ?? summary.rootPath}>{blueprint?.document.projectPath ?? summary.rootPath}</p>
      </section>

      <section className="stat-grid">
        {blueprint ? (
          <>
            <article><strong>{blueprint.document.nodes.length}</strong><span>узлов плана</span></article>
            <article><strong>{blueprint.document.edges.length}</strong><span>связей</span></article>
            <article><strong>{blueprint.document.nodes.filter((node) => node.status === 'implemented').length}</strong><span>реализовано</span></article>
            <article><strong>{blueprint.document.nodes.filter((node) => node.status !== 'implemented').length}</strong><span>в плане</span></article>
          </>
        ) : (
          <>
            <article><strong>{summary.services}</strong><span>сервисов</span></article>
            <article><strong>{summary.modules}</strong><span>модулей</span></article>
            <article><strong>{summary.symbols}</strong><span>символов</span></article>
            <article><strong>{summary.filesScanned}</strong><span>файлов</span></article>
          </>
        )}
      </section>

      {!blueprint ? (
        <>
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

      <section className="sidebar-section git-section">
        <div className="section-heading"><h2>Git-история</h2><span>{summary.git.available ? summary.git.branch ?? 'detached' : '—'}</span></div>
        {summary.git.available ? (
          <>
            <div className="git-stats">
              <div><strong>{summary.git.commitsAnalyzed}</strong><span>коммитов</span></div>
              <div><strong>{summary.git.contributors.length}</strong><span>авторов</span></div>
            </div>
            <form className="git-compare" onSubmit={handleCompare}>
              <input
                value={compareRef}
                onChange={(event) => setCompareRef(event.target.value)}
                placeholder="ветка, тег или hash"
                aria-label="Git-ветка или тег для сравнения"
              />
              <button type="submit" disabled={loading || !compareRef.trim()}>Сравнить</button>
            </form>
            {summary.git.comparison ? (
              <div className="comparison-summary">
                <strong>Δ {summary.git.comparison.baseRef}</strong>
                <span>{summary.git.comparison.changedFiles} файлов</span>
                <small>+{summary.git.comparison.added} · ~{summary.git.comparison.modified} · −{summary.git.comparison.deleted}</small>
                {summary.git.comparison.architecture ? (
                  <small className="architecture-diff-summary">
                    Узлы +{summary.git.comparison.architecture.nodesAdded}
                    {' · '}~{summary.git.comparison.architecture.nodesModified}
                    {' · '}−{summary.git.comparison.architecture.nodesRemoved}
                    <br />Связи +{summary.git.comparison.architecture.edgesAdded}
                    {' · '}−{summary.git.comparison.architecture.edgesRemoved}
                  </small>
                ) : null}
              </div>
            ) : null}
          </>
        ) : <p className="diagnostic-empty">Git-репозиторий не найден</p>}
      </section>

      <footer>
        <span className="status-dot" />
        Снимок за {summary.durationMs} мс
        {summary.incremental && summary.incremental.eligibleFiles > 0
          ? ` · кэш ${summary.incremental.reusedFiles}/${summary.incremental.eligibleFiles}`
          : ''}
        {summary.execution?.isolated
          ? ` · worker #${summary.execution.workerThreadId ?? '?'}`
          : ''}
      </footer>
        </>
      ) : (
        <section className="sidebar-section blueprint-sidebar-note">
          <h2>Отдельный документ</h2>
          <p>Это сохранённая целевая архитектура, а не карта случайно выбранной папки. История анализа кода открывается отдельной кнопкой «Снимки» над картой.</p>
        </section>
      )}
    </aside>
  );
}
