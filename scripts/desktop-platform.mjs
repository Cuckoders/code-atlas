const TARGET_TRIPLE_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function assertTargetTriple(targetTriple) {
  if (typeof targetTriple !== 'string' || !TARGET_TRIPLE_PATTERN.test(targetTriple)) {
    throw new Error('Invalid Tauri target triple.');
  }
  return targetTriple;
}

export function platformForTargetTriple(targetTriple) {
  assertTargetTriple(targetTriple);
  if (/-windows-(?:msvc|gnu)$/.test(targetTriple)) return 'win32';
  if (/-apple-darwin$/.test(targetTriple)) return 'darwin';
  if (/-linux-(?:gnu|musl)$/.test(targetTriple)) return 'linux';
  throw new Error(`Unsupported desktop target triple: ${targetTriple}`);
}

export function sidecarFileName(targetTriple) {
  const platform = platformForTargetTriple(targetTriple);
  return `code-atlas-node-${targetTriple}${platform === 'win32' ? '.exe' : ''}`;
}

export function assertNativeTarget(hostTriple, targetTriple, hostPlatform) {
  assertTargetTriple(hostTriple);
  assertTargetTriple(targetTriple);
  const targetPlatform = platformForTargetTriple(targetTriple);
  if (targetTriple !== hostTriple) {
    throw new Error(`Cannot package the ${hostTriple} Node runtime for cross-target ${targetTriple}. Run this build on the target platform.`);
  }
  if (targetPlatform !== hostPlatform) {
    throw new Error(`Target ${targetTriple} does not match the current ${hostPlatform} platform.`);
  }
}
