import { useCallback, useEffect, useState } from 'react';
import type { BlueprintDocument, BlueprintDocumentSummary } from '../../shared/blueprint';
import { apiFetch } from '../desktop';

interface BlueprintLibraryProps {
  projectPath: string;
  activeId: string | null;
  onClose: () => void;
  onOpen: (document: BlueprintDocument) => void;
  onNew?: (name: string) => void;
  openLabel?: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function BlueprintLibrary({ projectPath, activeId, onClose, onOpen, onNew, openLabel = 'Открыть' }: BlueprintLibraryProps) {
  const [items, setItems] = useState<BlueprintDocumentSummary[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('Новый blueprint');
  const [busyId, setBusyId] = useState<string | null>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusyId('loading');
    setError(null);
    try {
      const response = await apiFetch(`/api/blueprints/documents?projectPath=${encodeURIComponent(projectPath)}`);
      const payload = await response.json() as BlueprintDocumentSummary[] | { error: string };
      if (!response.ok || !Array.isArray(payload)) throw new Error('error' in payload ? payload.error : 'Не удалось загрузить библиотеку.');
      setItems(payload);
      setNames(Object.fromEntries(payload.map((item) => [item.id, item.name])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить библиотеку.');
    } finally {
      setBusyId(null);
    }
  }, [projectPath]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const open = async (item: BlueprintDocumentSummary) => {
    setBusyId(item.id);
    setError(null);
    try {
      const response = await apiFetch(`/api/blueprints/documents/${item.id}?projectPath=${encodeURIComponent(projectPath)}`);
      const payload = await response.json() as BlueprintDocument | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Не удалось открыть blueprint.');
      onOpen(payload);
      onClose();
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Не удалось открыть blueprint.');
      setBusyId(null);
    }
  };

  const rename = async (item: BlueprintDocumentSummary) => {
    const name = names[item.id]?.trim();
    if (!name || name === item.name) return;
    await mutate(item.id, `/api/blueprints/documents/${item.id}`, 'PATCH', { projectPath, name });
  };

  const duplicate = async (item: BlueprintDocumentSummary) => {
    await mutate(item.id, `/api/blueprints/documents/${item.id}/duplicate`, 'POST', {
      projectPath,
      name: `${item.name} — копия`,
    });
  };

  const remove = async (item: BlueprintDocumentSummary) => {
    if (!window.confirm(`Удалить blueprint «${item.name}»? Это действие нельзя отменить.`)) return;
    setBusyId(item.id);
    setError(null);
    try {
      const response = await apiFetch(`/api/blueprints/documents/${item.id}?projectPath=${encodeURIComponent(projectPath)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? 'Не удалось удалить blueprint.');
      }
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Не удалось удалить blueprint.');
      setBusyId(null);
    }
  };

  const mutate = async (id: string, url: string, method: 'POST' | 'PATCH', body: unknown) => {
    setBusyId(id);
    setError(null);
    try {
      const response = await apiFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as BlueprintDocument | { error: string };
      if (!response.ok || 'error' in payload) throw new Error('error' in payload ? payload.error : 'Операция не выполнена.');
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Операция не выполнена.');
      setBusyId(null);
    }
  };

  return (
    <div className="blueprint-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="blueprint-library" role="dialog" aria-modal="true" aria-label="Мои blueprint">
        <header>
          <div><span>Локальная библиотека</span><h2>Мои blueprint</h2></div>
          <button type="button" aria-label="Закрыть библиотеку blueprint" onClick={onClose}>×</button>
        </header>
        {onNew ? (
          <div className="blueprint-library__new">
            <label><span>Название новой схемы</span><input name="new-blueprint-name" maxLength={128} value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
            <button type="button" disabled={!newName.trim()} onClick={() => { onNew(newName.trim()); onClose(); }}>＋ Создать</button>
          </div>
        ) : <div className="blueprint-library__new blueprint-library__browse-note"><span>Выберите сохранённый Blueprint, чтобы открыть его как самостоятельную карту.</span></div>}
        {error ? <p className="blueprint-library__error" role="alert">{error}</p> : null}
        <div className="blueprint-library__list">
          {busyId === 'loading' ? <p>Загружаем blueprint…</p> : items.length ? items.map((item) => (
            <article className={item.id === activeId ? 'is-active' : ''} key={item.id}>
              <div className="blueprint-library__meta"><span>{item.id === activeId ? 'Открыт' : 'Blueprint'}</span><time dateTime={item.updatedAt}>{DATE_FORMAT.format(new Date(item.updatedAt))}</time></div>
              <input aria-label={`Название blueprint ${item.name}`} maxLength={128} value={names[item.id] ?? item.name} onChange={(event) => setNames((current) => ({ ...current, [item.id]: event.target.value }))} />
              <small>{item.nodeCount} узлов · {item.edgeCount} связей</small>
              <div>
                <button type="button" disabled={busyId === item.id} onClick={() => void open(item)}>{openLabel}</button>
                <button type="button" disabled={busyId === item.id || !names[item.id]?.trim() || names[item.id] === item.name} onClick={() => void rename(item)}>Переименовать</button>
                <button type="button" disabled={busyId === item.id} onClick={() => void duplicate(item)}>Копия</button>
                <button type="button" className="is-danger" disabled={busyId === item.id} onClick={() => void remove(item)}>Удалить</button>
              </div>
            </article>
          )) : <div className="blueprint-library__empty"><strong>Сохранённых blueprint пока нет</strong><span>Создайте первую схему или сохраните текущую.</span></div>}
        </div>
      </section>
    </div>
  );
}
