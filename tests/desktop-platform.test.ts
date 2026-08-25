import { describe, expect, it } from 'vitest';
import {
  assertNativeTarget,
  assertTargetTriple,
  platformForTargetTriple,
  sidecarFileName,
} from '../scripts/desktop-platform.mjs';

describe('desktop platform contract', () => {
  it('uses an executable sidecar name for Windows targets', () => {
    expect(platformForTargetTriple('x86_64-pc-windows-msvc')).toBe('win32');
    expect(sidecarFileName('x86_64-pc-windows-msvc')).toBe('code-atlas-node-x86_64-pc-windows-msvc.exe');
    expect(sidecarFileName('aarch64-pc-windows-msvc')).toBe('code-atlas-node-aarch64-pc-windows-msvc.exe');
  });

  it('keeps Unix sidecars extensionless', () => {
    expect(sidecarFileName('aarch64-apple-darwin')).toBe('code-atlas-node-aarch64-apple-darwin');
    expect(sidecarFileName('x86_64-unknown-linux-gnu')).toBe('code-atlas-node-x86_64-unknown-linux-gnu');
  });

  it('rejects malformed, unsupported and cross-platform targets', () => {
    expect(() => assertTargetTriple('../../malicious.exe')).toThrow('Invalid Tauri target triple');
    expect(() => platformForTargetTriple('wasm32-unknown-unknown')).toThrow('Unsupported desktop target triple');
    expect(() => assertNativeTarget(
      'aarch64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'darwin',
    )).toThrow('Cannot package');
    expect(() => assertNativeTarget(
      'x86_64-pc-windows-msvc',
      'x86_64-pc-windows-msvc',
      'darwin',
    )).toThrow('does not match');
  });
});
