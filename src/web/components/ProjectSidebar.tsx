import { useState, type FormEvent } from 'react';
import type { AnalysisSnapshotSummary, ProjectDiagnostic, ProjectSummary } from '../../shared/graph';

interface ProjectSidebarProps {
  summary: ProjectSummary;
  diagnostics: ProjectDiagnostic[];
  onSelectDiagnostic: (diagnostic: ProjectDiagnostic) => void;
  onCompare: (reference: string) => void;
  snapshots: AnalysisSnapshotSummary[];
  activeSnapshotId: string | null;
  onOpenSnapshot: (snapshotId: string) => void;
  loading: boolean;
}

const SNAPSHOT_DATE = new Intl.DateTimeFormat('ru', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function ProjectSidebar({
  summary,
  diagnostics,
  onSelectDiagnostic,
  onCompare,
  snapshots,
  activeSnapshotId,
  onOpenSnapshot,
  loading,
}: ProjectSidebarProps) {
  const [compareRef, setCompareRef] = useState('main');

  const handleCompare = (event: FormEvent) => {
    event.preventDefault();
    if (compareRef.trim()) onCompare(compareRef.trim());
  };

  return (
    <aside className="project-sidebar" id="project-sidebar" aria-label="Обзор проекта">
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

      <section className="sidebar-section snapshot-section">
        <div className="section-heading"><h2>Снимки</h2><span>{snapshots.length}</span></div>
        {snapshots.length ? (
          <div className="snapshot-list">
            {snapshots.slice(0, 5).map((snapshot) => (
              <button
                type="button"
                className={snapshot.id === activeSnapshotId ? 'is-active' : ''}
                disabled={loading || snapshot.id === activeSnapshotId}
                key={snapshot.id}
                onClick={() => onOpenSnapshot(snapshot.id)}
                title={snapshot.projectPath}
              >
                <span><strong>{snapshot.projectName}</strong><small>{SNAPSHOT_DATE.format(new Date(snapshot.createdAt))}</small></span>
                <i>{snapshot.compareRef ? `Δ ${snapshot.compareRef}` : `${snapshot.nodeCount} уз.`}</i>
              </button>
            ))}
          </div>
        ) : <p className="diagnostic-empty">Фоновые снимки появятся после анализа проекта</p>}
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

      <section className="sidebar-section diagnostics-section">
        <div className="section-heading"><h2>Диагностика</h2><span>{diagnostics.length}</span></div>
        {diagnostics.length ? (
          <div className="diagnostic-list">
            {diagnostics.slice(0, 6).map((diagnostic) => (
              <button
                type="button"
                className={`diagnostic diagnostic--${diagnostic.severity}`}
                key={diagnostic.id}
                onClick={() => onSelectDiagnostic(diagnostic)}
                title={diagnostic.message}
              >
                <i />
                <span><strong>{diagnostic.title}</strong><small>{diagnostic.message}</small></span>
              </button>
            ))}
            {diagnostics.length > 6 ? <p className="diagnostic-more">Ещё {diagnostics.length - 6}</p> : null}
          </div>
        ) : <p className="diagnostic-empty">Явных архитектурных рисков не найдено</p>}
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
    </aside>
  );
}
