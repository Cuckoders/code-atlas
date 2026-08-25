import { invoke, isTauri } from '@tauri-apps/api/core';
import { BLUEPRINT_FILE_EXTENSION, MAX_BLUEPRINT_FILE_SIZE } from '../shared/blueprint-file';

interface BackendConnection {
  origin: string;
  token: string | null;
}

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const DESKTOP_TOKEN = /^[0-9a-f]{64}$/;
let backendConnection: Promise<BackendConnection> | undefined;

export function hasNativeDirectoryPicker(): boolean {
  return isTauri();
}

export async function chooseProjectDirectory(): Promise<string | null> {
  if (!hasNativeDirectoryPicker()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selection = await open({
    title: 'Выберите проект для анализа',
    directory: true,
    multiple: false,
    recursive: true,
    canCreateDirectories: false,
  });

  return typeof selection === 'string' ? selection : null;
}

export async function saveBlueprintFile(defaultName: string, contents: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const selectedPath = await save({
      title: 'Сохранить Blueprint',
      defaultPath: defaultName,
      filters: [{ name: 'Code Atlas Blueprint', extensions: ['json'] }],
    });
    if (!selectedPath) return false;
    await invoke('write_blueprint_file', { path: selectedPath, contents });
    return true;
  }

  const pickerWindow = window as Window & {
    showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }> }>;
  };
  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'Code Atlas Blueprint', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
      return true;
    } catch (pickerError) {
      if (pickerError instanceof DOMException && pickerError.name === 'AbortError') return false;
      throw pickerError;
    }
  }

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  link.download = defaultName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  return true;
}

export async function chooseBlueprintFile(): Promise<{ name: string; contents: string } | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selectedPath = await open({
      title: 'Открыть Blueprint',
      directory: false,
      multiple: false,
      filters: [{ name: 'Code Atlas Blueprint', extensions: ['json'] }],
    });
    if (typeof selectedPath !== 'string') return null;
    return {
      name: selectedPath.split(/[\\/]/).at(-1) ?? `blueprint${BLUEPRINT_FILE_EXTENSION}`,
      contents: await invoke<string>('read_blueprint_file', { path: selectedPath }),
    };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.code-atlas-blueprint.json,application/json';
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > MAX_BLUEPRINT_FILE_SIZE) {
        reject(new Error('Файл Blueprint слишком большой.'));
        return;
      }
      file.text().then((contents) => resolve({ name: file.name, contents }), reject);
    };
    input.click();
  });
}

export async function apiFetch(apiPath: string, init?: RequestInit): Promise<Response> {
  if (!apiPath.startsWith('/api/') || apiPath.startsWith('//')) {
    throw new Error('Code Atlas API path must start with /api/');
  }
  if (!isTauri()) return fetch(apiPath, init);

  const connection = await getDesktopBackend();
  const headers = new Headers(init?.headers);
  if (connection.token) headers.set('x-code-atlas-token', connection.token);
  return fetch(new URL(apiPath, `${connection.origin}/`), { ...init, headers });
}

export async function resolveBackendUrl(backendPath: string): Promise<string> {
  if (!backendPath.startsWith('/') || backendPath.startsWith('//')) {
    throw new Error('Backend path must be absolute and local.');
  }
  if (!isTauri()) return new URL(backendPath, window.location.origin).toString();
  const connection = await getDesktopBackend();
  return new URL(backendPath, `${connection.origin}/`).toString();
}

async function getDesktopBackend(): Promise<BackendConnection> {
  backendConnection ??= connectDesktopBackend();
  return backendConnection;
}

async function connectDesktopBackend(): Promise<BackendConnection> {
  const connection = await invoke<BackendConnection>('backend_connection');
  const port = Number.parseInt(LOOPBACK_ORIGIN.exec(connection.origin)?.[1] ?? '', 10);
  if (!Number.isInteger(port) || port > 65_535) throw new Error('Desktop backend returned an invalid loopback origin.');
  if (connection.token !== null && !DESKTOP_TOKEN.test(connection.token)) {
    throw new Error('Desktop backend returned an invalid session token.');
  }

  const headers = connection.token ? { 'x-code-atlas-token': connection.token } : undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${connection.origin}/api/health`, { headers, cache: 'no-store' });
      if (response.ok) return connection;
    } catch {
      // The sidecar may still be binding its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('Desktop backend did not become ready in time.');
}
