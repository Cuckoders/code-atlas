import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { AnalysisJobPriority, ProjectAnalysis } from '../shared/graph.js';
import { AnalysisQueue } from './analysis-queue.js';
import { AnalysisError, analyzeProject, type AnalyzeProjectOptions } from './analyzer.js';
import { SnapshotStore } from './snapshot-store.js';

interface CreateAppOptions {
  logger?: boolean;
  demoPath?: string;
  staticRoot?: string;
  databasePath?: string;
  analyze?: (projectPath: string, options: AnalyzeProjectOptions) => Promise<ProjectAnalysis>;
  analysisConcurrency?: number;
  apiToken?: string;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 16 * 1024,
  });

  await app.register(cors, {
    origin: /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/,
    allowedHeaders: ['content-type', 'x-code-atlas-token'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });

  if (options.apiToken) {
    const expectedToken = Buffer.from(options.apiToken);
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const tokenHeader = request.headers['x-code-atlas-token'];
      const providedToken = typeof tokenHeader === 'string' ? Buffer.from(tokenHeader) : null;
      if (!providedToken
        || providedToken.byteLength !== expectedToken.byteLength
        || !timingSafeEqual(providedToken, expectedToken)) {
        return reply.status(401).send({ error: 'Недействительный токен desktop-сессии.' });
      }
    });
  }

  const defaultDatabasePath = path.resolve(process.cwd(), '.code-atlas/code-atlas.sqlite');
  const snapshots = new SnapshotStore(options.databasePath ?? process.env.CODE_ATLAS_DATABASE ?? defaultDatabasePath);
  const queue = new AnalysisQueue(
    snapshots,
    options.analyze,
    (error) => app.log.error(error),
    options.analysisConcurrency,
  );
  app.addHook('onClose', async () => {
    await queue.close();
    snapshots.close();
  });

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

  app.post<{ Body: { path: string; compareRef?: string } }>('/api/analyze', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      body: analysisRequestSchema,
    },
  }, async (request) => {
    const analysis = await analyzeProject(request.body.path, {
      compareRef: request.body.compareRef,
      parseCache: snapshots,
    });
    snapshots.pruneParsedSources();
    return analysis;
  });

  app.post<{ Body: { path: string; compareRef?: string; priority?: AnalysisJobPriority } }>('/api/analysis-jobs', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      body: analysisJobRequestSchema,
    },
  }, async (request, reply) => {
    const job = queue.enqueue(request.body.path, request.body.compareRef, request.body.priority);
    return reply.status(202).send(job);
  });

  app.get<{ Params: { id: string } }>('/api/analysis-jobs/:id', {
    schema: { params: identifierParamsSchema },
  }, async (request, reply) => {
    const job = queue.get(request.params.id);
    return job ?? reply.status(404).send({ error: 'Задание анализа не найдено.' });
  });

  app.delete<{ Params: { id: string } }>('/api/analysis-jobs/:id', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
    schema: { params: identifierParamsSchema },
  }, async (request, reply) => {
    const job = queue.cancel(request.params.id);
    return job ?? reply.status(404).send({ error: 'Задание анализа не найдено.' });
  });

  app.get<{ Querystring: { limit?: number } }>('/api/snapshots', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      },
    },
  }, async (request) => snapshots.list(request.query.limit));

  app.get<{ Params: { id: string } }>('/api/snapshots/:id', {
    schema: { params: identifierParamsSchema },
  }, async (request, reply) => {
    const snapshot = snapshots.get(request.params.id);
    return snapshot ?? reply.status(404).send({ error: 'Снимок анализа не найден.' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AnalysisError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.status(400).send({ error: 'Проверьте параметры запроса.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Не удалось проанализировать проект.' });
  });

  return app;
}

const analysisRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 4_096 },
    compareRef: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._/@-]*$',
    },
  },
} as const;

const analysisJobRequestSchema = {
  ...analysisRequestSchema,
  properties: {
    ...analysisRequestSchema.properties,
    priority: { type: 'string', enum: ['normal', 'high'] },
  },
} as const;

const identifierParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;
