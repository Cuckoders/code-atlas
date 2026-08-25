import { invoke, isTauri } from '@tauri-apps/api/core';
import { BLUEPRINT_FILE_EXTENSION, MAX_BLUEPRINT_FILE_SIZE } from '../shared/blueprint-file';
import type { BlueprintScaffold, SavedBlueprintProject } from '../shared/blueprint-codegen';

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

interface BrowserFileHandle {
  getFile: () => Promise<File>;
  createWritable: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }>;
}

interface BrowserDirectoryHandle {
  name: string;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserFileHandle>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<BrowserDirectoryHandle>;
};

export async function saveBlueprintProject(scaffold: BlueprintScaffold): Promise<SavedBlueprintProject | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const parentPath = await open({
      title: 'Куда сохранить папку Blueprint',
      directory: true,
      multiple: false,
      recursive: true,
      canCreateDirectories: true,
    });
    if (typeof parentPath !== 'string') return null;
    return invoke<SavedBlueprintProject>('write_blueprint_project', {
      parentPath,
      folderName: scaffold.folderName,
      files: scaffold.files,
    });
  }

  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('Браузер не поддерживает сохранение папок. Откройте Code Atlas в Chrome/Edge или используйте desktop-версию.');
  try {
    const parent = await picker({ mode: 'readwrite' });
    const destination = await parent.getDirectoryHandle(scaffold.folderName, { create: true });
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of scaffold.files) {
      const parts = file.path.split('/');
      const fileName = parts.pop();
      if (!fileName) continue;
      let directory = destination;
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      if (!file.overwrite && await browserFileExists(directory, fileName)) {
        skipped.push(file.path);
        continue;
      }
      const handle = await directory.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file.contents);
      await writable.close();
      written.push(file.path);
    }
    return { folderName: scaffold.folderName, written, skipped };
  } catch (pickerError) {
    if (pickerError instanceof DOMException && pickerError.name === 'AbortError') return null;
    throw pickerError;
  }
}

export async function chooseBlueprintProject(): Promise<{ name: string; contents: string } | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selectedPath = await open({
      title: 'Открыть папку Blueprint',
      directory: true,
      multiple: false,
      recursive: true,
      canCreateDirectories: false,
    });
    if (typeof selectedPath !== 'string') return null;
    return {
      name: selectedPath.split(/[\\/]/).at(-1) ?? 'Blueprint',
      contents: await invoke<string>('read_blueprint_project', { path: selectedPath }),
    };
  }

  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (picker) {
    try {
      const directory = await picker({ mode: 'read' });
      const manifest = await directory.getFileHandle('code-atlas.blueprint.json');
      const file = await manifest.getFile();
      if (file.size > MAX_BLUEPRINT_FILE_SIZE) throw new Error('Манифест Blueprint слишком большой.');
      return { name: directory.name, contents: await file.text() };
    } catch (pickerError) {
      if (pickerError instanceof DOMException && pickerError.name === 'AbortError') return null;
      if (pickerError instanceof DOMException && pickerError.name === 'NotFoundError') {
        throw new Error('В выбранной папке нет code-atlas.blueprint.json. Сохраните Blueprint как проект заново.');
      }
      throw pickerError;
    }
  }

  return chooseBlueprintDirectoryUpload();
}

async function browserFileExists(directory: BrowserDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}

function chooseBlueprintDirectoryUpload(): Promise<{ name: string; contents: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      const manifest = files.find((file) => file.name === 'code-atlas.blueprint.json');
      if (!manifest) {
        reject(new Error('В выбранной папке нет code-atlas.blueprint.json.'));
        return;
      }
      if (manifest.size > MAX_BLUEPRINT_FILE_SIZE) {
        reject(new Error('Манифест Blueprint слишком большой.'));
        return;
      }
      const relativePath = (manifest as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
      const folderName = relativePath.split('/')[0] || 'Blueprint';
      manifest.text().then((contents) => resolve({ name: folderName, contents }), reject);
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
