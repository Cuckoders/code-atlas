import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  BLUEPRINT_BEHAVIOR_KINDS,
  BLUEPRINT_CODE_TEMPLATES,
  BLUEPRINT_NODE_KINDS,
  BLUEPRINT_NODE_STATUSES,
  BLUEPRINT_VERSION,
  MAX_BLUEPRINT_EDGES,
  MAX_BLUEPRINT_JSON_SIZE,
  MAX_BLUEPRINT_NODES,
  validateArchitectureBlueprint,
  type ArchitectureBlueprintDraft,
} from '../shared/blueprint.js';
import type { BlueprintCodegenRequest } from '../shared/blueprint-codegen.js';
import type { RequestProbeInput, RequestProbeResult } from '../shared/request-trace.js';
import { AnalysisQueue } from './analysis-queue.js';
import { AnalysisError, analyzeProject, type AnalyzeProjectOptions } from './analyzer.js';
import { BlueprintCodegenError, generateBlueprintCode } from './blueprint-codegen.js';
import { executeRequestProbe, RequestProbeValidationError } from './request-probe.js';
import {
  createDemoOtlpPayload,
  MAX_OTLP_JSON_SIZE,
  parseOtlpJson,
  RuntimeTraceValidationError,
} from './runtime-trace.js';
import { SnapshotStore } from './snapshot-store.js';
import { openSourceFile, SourceEditorError, type EditorLauncher } from './source-editor.js';
import { SOURCE_EDITORS, type OpenSourceRequest } from '../shared/source-editor.js';

interface CreateAppOptions {
  logger?: boolean;
  demoPath?: string;
  staticRoot?: string;
  databasePath?: string;
  analyze?: (projectPath: string, options: AnalyzeProjectOptions) => Promise<ProjectAnalysis>;
  analysisConcurrency?: number;
  apiToken?: string;
  requestProbe?: (input: RequestProbeInput) => Promise<RequestProbeResult>;
  launchEditor?: EditorLauncher;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const collectorToken = randomBytes(32).toString('hex');
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 16 * 1024,
  });

  await app.register(cors, {
    origin: /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/,
    allowedHeaders: ['content-type', 'x-code-atlas-token', 'x-code-atlas-otlp-token'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });

  const expectedApiToken = options.apiToken ? Buffer.from(options.apiToken) : null;
  const expectedCollectorToken = Buffer.from(collectorToken);
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    if (request.url.split('?', 1)[0] === '/v1/traces') {
      const tokenHeader = request.headers['x-code-atlas-otlp-token'];
      const providedToken = typeof tokenHeader === 'string' ? Buffer.from(tokenHeader) : null;
      if (!providedToken
        || providedToken.byteLength !== expectedCollectorToken.byteLength
        || !timingSafeEqual(providedToken, expectedCollectorToken)) {
        return reply.status(401).send({ error: 'Недействительный токен локального OTLP-коллектора.' });
      }
      return;
    }
    if (expectedApiToken) {
      const tokenHeader = request.headers['x-code-atlas-token'];
      const providedToken = typeof tokenHeader === 'string' ? Buffer.from(tokenHeader) : null;
      if (!providedToken
        || providedToken.byteLength !== expectedApiToken.byteLength
        || !timingSafeEqual(providedToken, expectedApiToken)) {
        return reply.status(401).send({ error: 'Недействительный токен desktop-сессии.' });
      }
    }
  });

  const defaultDatabasePath = path.resolve(process.cwd(), '.code-atlas/code-atlas.sqlite');
  const snapshots = new SnapshotStore(options.databasePath ?? process.env.CODE_ATLAS_DATABASE ?? defaultDatabasePath);
  const queue = new AnalysisQueue(
    snapshots,
    options.analyze,
    (error) => app.log.error(error),
    options.analysisConcurrency,
  );
  const requestProbe = options.requestProbe ?? executeRequestProbe;
  const launchEditor = options.launchEditor;
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

  app.post<{ Body: OpenSourceRequest }>('/api/source/open', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: openSourceSchema },
  }, async (request, reply) => {
    try {
      return await openSourceFile(request.body, launchEditor);
    } catch (error) {
      if (error instanceof SourceEditorError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Querystring: { projectPath: string } }>('/api/runtime-traces/collector', {
    schema: { querystring: projectPathQuerySchema },
  }, async (request) => ({
    endpoint: `/v1/traces?projectPath=${encodeURIComponent(request.query.projectPath)}`,
    token: collectorToken,
    protocol: 'otlp-http-json',
    limits: { bodyBytes: MAX_OTLP_JSON_SIZE, spansPerBatch: 500 },
  }));

  app.post<{ Querystring: { projectPath: string }; Body: unknown }>('/v1/traces', {
    bodyLimit: MAX_OTLP_JSON_SIZE,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: { querystring: projectPathQuerySchema },
  }, async (request, reply) => {
    try {
      const sessions = parseOtlpJson(request.body, request.query.projectPath);
      snapshots.saveRuntimeTraces(sessions);
      return { partialSuccess: {} };
    } catch (error) {
      if (error instanceof RuntimeTraceValidationError) return reply.status(400).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Body: { projectPath: string } }>('/api/runtime-traces/demo', {
    bodyLimit: 4_096,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['projectPath'],
        properties: projectPathQuerySchema.properties,
      },
    },
  }, async (request) => {
    const sessions = parseOtlpJson(createDemoOtlpPayload(), request.body.projectPath);
    return snapshots.saveRuntimeTraces(sessions)[0];
  });

  app.get<{ Querystring: { projectPath: string; limit?: number } }>('/api/runtime-traces', {
    schema: {
      querystring: {
        ...projectPathQuerySchema,
        properties: {
          ...projectPathQuerySchema.properties,
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
  }, async (request) => snapshots.listRuntimeTraces(request.query.projectPath, request.query.limit));

  app.get<{ Params: { id: string } }>('/api/runtime-traces/:id', {
    schema: { params: identifierParamsSchema },
  }, async (request, reply) => {
    const session = snapshots.getRuntimeTrace(request.params.id);
    return session ?? reply.status(404).send({ error: 'Runtime trace не найден.' });
  });

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

  app.get<{ Querystring: { limit?: number; projectPath?: string } }>('/api/snapshots', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          projectPath: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
      },
    },
  }, async (request) => snapshots.list(request.query.limit, request.query.projectPath));

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

  app.get<{ Querystring: { projectPath: string } }>('/api/blueprints/documents', {
    schema: { querystring: blueprintQuerySchema },
  }, async (request) => snapshots.listBlueprintDocuments(request.query.projectPath));

  app.get<{ Params: { id: string }; Querystring: { projectPath: string } }>('/api/blueprints/documents/:id', {
    schema: { params: identifierParamsSchema, querystring: blueprintQuerySchema },
  }, async (request, reply) => {
    const document = snapshots.getBlueprintDocument(request.query.projectPath, request.params.id);
    return document ?? reply.status(404).send({ error: 'Blueprint не найден.' });
  });

  app.post<{ Body: { id?: string; name: string; blueprint: ArchitectureBlueprintDraft } }>('/api/blueprints/documents', {
    bodyLimit: MAX_BLUEPRINT_JSON_SIZE,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: blueprintDocumentSaveSchema },
  }, async (request, reply) => {
    const validationError = validateArchitectureBlueprint(request.body.blueprint);
    if (validationError) return reply.status(400).send({ error: validationError });
    try {
      const document = snapshots.saveBlueprintDocument(request.body.name, request.body.blueprint, request.body.id);
      return reply.status(request.body.id ? 200 : 201).send(document);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Не удалось сохранить blueprint.' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { projectPath: string; name: string } }>('/api/blueprints/documents/:id', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: identifierParamsSchema, body: blueprintDocumentActionSchema },
  }, async (request, reply) => {
    try {
      const document = snapshots.renameBlueprintDocument(request.body.projectPath, request.params.id, request.body.name);
      return document ?? reply.status(404).send({ error: 'Blueprint не найден.' });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Не удалось переименовать blueprint.' });
    }
  });

  app.post<{ Params: { id: string }; Body: { projectPath: string; name: string } }>('/api/blueprints/documents/:id/duplicate', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: identifierParamsSchema, body: blueprintDocumentActionSchema },
  }, async (request, reply) => {
    try {
      const document = snapshots.duplicateBlueprintDocument(request.body.projectPath, request.params.id, request.body.name);
      return document ? reply.status(201).send(document) : reply.status(404).send({ error: 'Blueprint не найден.' });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Не удалось дублировать blueprint.' });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { projectPath: string } }>('/api/blueprints/documents/:id', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: identifierParamsSchema, querystring: blueprintQuerySchema },
  }, async (request, reply) => snapshots.deleteBlueprintDocument(request.query.projectPath, request.params.id)
    ? reply.status(204).send()
    : reply.status(404).send({ error: 'Blueprint не найден.' }));

  app.post<{ Body: BlueprintCodegenRequest }>('/api/blueprints/generate', {
    bodyLimit: MAX_BLUEPRINT_JSON_SIZE,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: blueprintCodegenSchema },
  }, async (request, reply) => {
    try {
      return await generateBlueprintCode(request.body);
    } catch (error) {
      if (error instanceof BlueprintCodegenError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
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

const openSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectPath', 'filePath', 'editor'],
  properties: {
    projectPath: { type: 'string', minLength: 1, maxLength: 4_096, pattern: '^[^\\u0000\\r\\n]+$' },
    filePath: { type: 'string', minLength: 1, maxLength: 4_096, pattern: '^[^\\u0000\\r\\n]+$' },
    editor: { type: 'string', enum: SOURCE_EDITORS },
    line: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    column: { type: 'integer', minimum: 1, maximum: 100_000 },
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

const projectPathQuerySchema = {
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
          behavior: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: BLUEPRINT_BEHAVIOR_KINDS },
              config: { type: 'string', maxLength: 4_096, pattern: '^[^\\u0000]*$' },
              delayMs: { type: 'integer', minimum: 0, maximum: 60_000 },
            },
          },
          codegen: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'template'],
            properties: {
              enabled: { type: 'boolean' },
              template: { type: 'string', enum: BLUEPRINT_CODE_TEMPLATES },
              fileName: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
            },
          },
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

const blueprintDocumentSaveSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'blueprint'],
  properties: {
    id: identifierParamsSchema.properties.id,
    name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000\\r\\n]+$' },
    blueprint: blueprintSchema,
  },
} as const;

const blueprintDocumentActionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectPath', 'name'],
  properties: {
    projectPath: blueprintQuerySchema.properties.projectPath,
    name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000\\r\\n]+$' },
  },
} as const;

const blueprintCodegenSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectPath', 'blueprintName', 'outputDirectory', 'blueprint'],
  properties: {
    projectPath: blueprintQuerySchema.properties.projectPath,
    blueprintName: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000\\r\\n]+$' },
    outputDirectory: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9._\\/\\\\-]+$' },
    blueprint: blueprintSchema,
  },
} as const;
