import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '4310', 10);
const app = await createApp();

const close = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ host: '127.0.0.1', port });
