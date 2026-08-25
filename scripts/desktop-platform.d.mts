export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

export function assertTargetTriple(targetTriple: string): string;
export function platformForTargetTriple(targetTriple: string): DesktopPlatform;
export function sidecarFileName(targetTriple: string): string;
export function assertNativeTarget(hostTriple: string, targetTriple: string, hostPlatform: NodeJS.Platform): void;
