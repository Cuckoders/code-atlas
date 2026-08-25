import { useEffect } from 'react';
import type { AnalysisSnapshotSummary } from '../../shared/graph';

interface SnapshotLibraryProps {
  projectName: string;
  projectPath: string;
  snapshots: AnalysisSnapshotSummary[];
  activeSnapshotId: string | null;
  loading: boolean;
  busyId: string | null;
  onOpen: (snapshotId: string) => void;
  onDelete: (snapshot: AnalysisSnapshotSummary) => void;
  onClose: () => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat('ru', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export default function SnapshotLibrary({
  projectName,
  projectPath,
  snapshots,
  activeSnapshotId,
  loading,
  busyId,
  onOpen,
  onDelete,
  onClose,
}: SnapshotLibraryProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="snapshot-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="snapshot-library" role="dialog" aria-modal="true" aria-label="Снимки анализа проекта">
        <header>
          <div><span>История анализа</span><h2>Снимки · {projectName}</h2><small title={projectPath}>{projectPath}</small></div>
          <button type="button" aria-label="Закрыть снимки" onClick={onClose}>×</button>
        </header>
        <div className="snapshot-library__list">
          {snapshots.length ? snapshots.map((snapshot) => (
            <article className={snapshot.id === activeSnapshotId ? 'is-active' : ''} key={snapshot.id}>
              <div className="snapshot-library__title">
                <span>{snapshot.id === activeSnapshotId ? 'Открыт на карте' : snapshot.compareRef ? `Сравнение с ${snapshot.compareRef}` : 'Анализ проекта'}</span>
                <time dateTime={snapshot.createdAt}>{DATE_FORMAT.format(new Date(snapshot.createdAt))}</time>
              </div>
              <dl>
                <div><dt>Узлы</dt><dd>{snapshot.nodeCount}</dd></div>
                <div><dt>Связи</dt><dd>{snapshot.edgeCount}</dd></div>
                <div><dt>Файлы</dt><dd>{snapshot.filesScanned}</dd></div>
                <div><dt>Время</dt><dd>{snapshot.durationMs} мс</dd></div>
              </dl>
              <div className="snapshot-library__actions">
                <button type="button" disabled={loading || busyId === snapshot.id || snapshot.id === activeSnapshotId} onClick={() => onOpen(snapshot.id)}>Открыть на карте</button>
                <button type="button" className="is-danger" disabled={busyId === snapshot.id} onClick={() => onDelete(snapshot)}>Удалить</button>
              </div>
            </article>
          )) : (
            <div className="snapshot-library__empty"><strong>Снимков этого проекта нет</strong><span>Новый снимок появится после анализа проекта.</span></div>
          )}
        </div>
        <footer>Снимки хранятся отдельно для каждого абсолютного пути проекта.</footer>
      </section>
    </div>
  );
}
