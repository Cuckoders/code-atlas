import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { AnalysisJobPriority, ProjectAnalysis } from '../shared/graph.js';
import {
  BLUEPRINT_EDGE_KINDS,
  BLUEPRINT_NODE_KINDS,
  BLUEPRINT_NODE_STATUSES,
  BLUEPRINT_VERSION,
  MAX_BLUEPRINT_EDGES,
  MAX_BLUEPRINT_JSON_SIZE,
  MAX_BLUEPRINT_NODES,
  validateArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
} from '../shared/blueprint.js';
import type { RequestProbeInput, RequestProbeResult } from '../shared/request-trace.js';
import { AnalysisQueue } from './analysis-queue.js';
import { AnalysisError, analyzeProject, type AnalyzeProjectOptions } from './analyzer.js';
import { executeRequestProbe, RequestProbeValidationError } from './request-probe.js';
import { SnapshotStore } from './snapshot-store.js';

interface CreateAppOptions {
  logger?: boolean;
  demoPath?: string;
  staticRoot?: string;
  databasePath?: string;
  analyze?: (projectPath: string, options: AnalyzeProjectOptions) => Promise<ProjectAnalysis>;
  analysisConcurrency?: number;
  apiToken?: string;
  requestProbe?: (input: RequestProbeInput) => Promise<RequestProbeResult>;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 16 * 1024,
  });

  await app.register(cors, {
    origin: /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/,
    allowedHeaders: ['content-type', 'x-code-atlas-token'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
  const requestProbe = options.requestProbe ?? executeRequestProbe;
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

  app.post<{ Body: RequestProbeInput }>('/api/request-probes', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
    schema: {
      body: requestProbeSchema,
    },
  }, async (request, reply) => {
    try {
      return await requestProbe(request.body);
    } catch (error) {
      if (error instanceof RequestProbeValidationError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

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

  app.get<{ Querystring: { projectPath: string } }>('/api/blueprints', {
    schema: { querystring: blueprintQuerySchema },
  }, async (request) => snapshots.getBlueprint(request.query.projectPath));

  app.put<{ Body: ArchitectureBlueprintDraft }>('/api/blueprints', {
    bodyLimit: MAX_BLUEPRINT_JSON_SIZE,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
    schema: { body: blueprintSchema },
  }, async (request, reply) => {
    const validationError = validateArchitectureBlueprint(request.body);
    if (validationError) return reply.status(400).send({ error: validationError });
    return snapshots.saveBlueprint(request.body);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AnalysisError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.status(400).send({ error: 'Проверьте параметры запроса.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Внутренняя ошибка Code Atlas.' });
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

const requestProbeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'url'],
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
    url: { type: 'string', minLength: 1, maxLength: 2_048 },
    headers: {
      type: 'object',
      maxProperties: 20,
      propertyNames: { pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" },
      additionalProperties: { type: 'string', maxLength: 2_048, pattern: '^[^\\r\\n]*$' },
    },
    body: { type: 'string', maxLength: 12_288 },
  },
} as const;

const blueprintQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectPath'],
  properties: {
    projectPath: { type: 'string', minLength: 1, maxLength: 4_096, pattern: '^[^\\u0000\\r\\n]+$' },
  },
} as const;

const blueprintSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'projectPath', 'nodes', 'edges'],
  properties: {
    version: { const: BLUEPRINT_VERSION },
    projectPath: { type: 'string', minLength: 1, maxLength: 4_096, pattern: '^[^\\u0000\\r\\n]+$' },
    nodes: {
      type: 'array',
      maxItems: MAX_BLUEPRINT_NODES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'kind', 'position', 'status'],
        properties: {
          id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
          label: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000\\r\\n]+$' },
          kind: { type: 'string', enum: BLUEPRINT_NODE_KINDS },
          status: { type: 'string', enum: BLUEPRINT_NODE_STATUSES },
          position: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: {
              x: { type: 'number', minimum: -100_000, maximum: 100_000 },
              y: { type: 'number', minimum: -100_000, maximum: 100_000 },
            },
          },
          technology: { type: 'string', maxLength: 128, pattern: '^[^\\u0000\\r\\n]*$' },
          language: { type: 'string', maxLength: 128, pattern: '^[^\\u0000\\r\\n]*$' },
          owner: { type: 'string', maxLength: 128, pattern: '^[^\\u0000\\r\\n]*$' },
          actualNodeId: { type: 'string', minLength: 1, maxLength: 1_024, pattern: '^[^\\u0000\\r\\n]+$' },
        },
      },
    },
    edges: {
      type: 'array',
      maxItems: MAX_BLUEPRINT_EDGES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'source', 'target', 'kind'],
        properties: {
          id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
          source: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string', enum: BLUEPRINT_EDGE_KINDS },
          label: { type: 'string', maxLength: 128, pattern: '^[^\\u0000\\r\\n]*$' },
        },
      },
    },
  },
} as const;
