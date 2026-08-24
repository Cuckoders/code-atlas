import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '4310', 10);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = process.env.NODE_ENV === 'production'
  ? path.resolve(currentDirectory, '../../dist')
  : undefined;
const app = await createApp({ staticRoot });

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: '127.0.0.1', port });
