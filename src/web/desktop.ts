import { invoke, isTauri } from '@tauri-apps/api/core';

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
