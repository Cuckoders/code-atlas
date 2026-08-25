import { describe, expect, it } from 'vitest';
import { chooseProjectDirectory, hasNativeDirectoryPicker } from '../src/web/desktop';

describe('desktop bridge', () => {
  it('keeps the native picker unavailable in a regular browser or Node process', async () => {
    expect(hasNativeDirectoryPicker()).toBe(false);
    await expect(chooseProjectDirectory()).resolves.toBeNull();
  });
});
