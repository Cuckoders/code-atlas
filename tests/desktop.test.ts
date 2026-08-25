import { describe, expect, it } from 'vitest';
import { apiFetch, chooseProjectDirectory, hasNativeDirectoryPicker } from '../src/web/desktop';

describe('desktop bridge', () => {
  it('keeps the native picker unavailable in a regular browser or Node process', async () => {
    expect(hasNativeDirectoryPicker()).toBe(false);
    await expect(chooseProjectDirectory()).resolves.toBeNull();
  });

  it('rejects non-API URLs before attaching desktop credentials', async () => {
    await expect(apiFetch('https://example.com/collect')).rejects.toThrow('must start with /api/');
    await expect(apiFetch('//example.com/api/collect')).rejects.toThrow('must start with /api/');
  });
});
