import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { AnalysisError, analyzeProject } from './analyzer.js';

interface CreateAppOptions {
  logger?: boolean;
  demoPath?: string;
  staticRoot?: string;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 16 * 1024,
  });

  await app.register(cors, {
    origin: /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });

  if (options.staticRoot) {
    await app.register(staticFiles, {
      root: options.staticRoot,
      index: ['index.html'],
    });
  }

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/demo', async () => {
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const defaultDemoPath = path.resolve(currentDirectory, '../../examples/sample-commerce');
    return analyzeProject(options.demoPath ?? defaultDemoPath);
  });

  app.post<{ Body: { path: string } }>('/api/analyze', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
      },
    },
  }, async (request) => analyzeProject(request.body.path));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AnalysisError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.status(400).send({ error: 'Проверьте путь к проекту.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Не удалось проанализировать проект.' });
  });

  return app;
}
