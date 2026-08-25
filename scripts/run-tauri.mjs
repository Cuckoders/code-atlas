import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const rustupBin = join(homedir(), '.cargo', 'bin');
const childEnvironment = {
  ...process.env,
  [pathKey]: [rustupBin, process.env[pathKey]].filter(Boolean).join(delimiter),
};
const tauriCli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const child = spawn(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  env: childEnvironment,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Не удалось запустить Tauri CLI: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
