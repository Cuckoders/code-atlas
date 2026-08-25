import { isTauri } from '@tauri-apps/api/core';

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
