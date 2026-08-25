import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '4310', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535');
const desktopSidecar = process.env.CODE_ATLAS_DESKTOP_SIDECAR === '1';
const apiToken = process.env.CODE_ATLAS_API_TOKEN;
if (desktopSidecar && !apiToken?.match(/^[0-9a-f]{64}$/)) {
  throw new Error('CODE_ATLAS_API_TOKEN must be a 256-bit lowercase hexadecimal token');
}
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = process.env.NODE_ENV === 'production' && !desktopSidecar
  ? path.resolve(currentDirectory, '../../dist')
  : undefined;
const app = await createApp({
  staticRoot,
  ...(process.env.CODE_ATLAS_DEMO_PATH ? { demoPath: process.env.CODE_ATLAS_DEMO_PATH } : {}),
  ...(process.env.CODE_ATLAS_DATABASE ? { databasePath: process.env.CODE_ATLAS_DATABASE } : {}),
  ...(apiToken ? { apiToken } : {}),
});

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: '127.0.0.1', port });
