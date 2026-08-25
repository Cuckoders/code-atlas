import { parentPort, threadId, workerData } from 'node:worker_threads';
import type { AnalysisProgress } from '../shared/graph.js';
import { AnalysisError, analyzeProject } from './analyzer.js';
import type { ParseCache } from './parse-cache.js';
import {
  validateMainMessage,
  validateWorkerData,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from './analysis-worker-protocol.js';
import type { ParsedSource } from './tree-sitter-parser.js';

if (!parentPort) throw new Error('Analysis worker requires a parent port');
const port = parentPort;
const input = validateWorkerData(workerData);
if (!input) throw new Error('Invalid analysis worker data');

class RemoteParseCache implements ParseCache {
  private sequence = 0;
  private readonly pending = new Map<string, {
    resolve: (parsed: ParsedSource | null) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    port.on('message', (value: unknown) => this.receive(value));
  }

  getParsedSource(projectPath: string, relativePath: string, contentHash: string): Promise<ParsedSource | null> {
    return this.request({ type: 'cache-get', projectPath, relativePath, contentHash });
  }

  async setParsedSource(
    projectPath: string,
    relativePath: string,
    contentHash: string,
    parsed: ParsedSource,
  ): Promise<void> {
    await this.request({ type: 'cache-set', projectPath, relativePath, contentHash, parsed });
  }

  private request(
    message: Omit<Extract<WorkerToMainMessage, { type: 'cache-get' }>, 'requestId'>
      | Omit<Extract<WorkerToMainMessage, { type: 'cache-set' }>, 'requestId'>,
  ): Promise<ParsedSource | null> {
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      port.postMessage({ ...message, requestId } satisfies WorkerToMainMessage);
    });
  }

  private receive(value: unknown): void {
    const message: MainToWorkerMessage | null = validateMainMessage(value);
    if (!message) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (!message.ok) pending.reject(new Error('Parse cache request failed'));
    else pending.resolve(message.parsed ?? null);
  }
}

const cache = new RemoteParseCache();

try {
  const analysis = await analyzeProject(input.projectPath, {
    compareRef: input.compareRef,
    parseCache: cache,
    onProgress: (progress: AnalysisProgress) => port.postMessage({ type: 'progress', progress } satisfies WorkerToMainMessage),
  });
  analysis.summary.execution = { isolated: true, workerThreadId: threadId };
  port.postMessage({ type: 'result', analysis } satisfies WorkerToMainMessage);
} catch (error) {
  const operational = error instanceof AnalysisError;
  port.postMessage({
    type: 'failure',
    operational,
    message: operational ? error.message : 'Не удалось проанализировать проект.',
    ...(!operational ? { diagnostic: diagnosticMessage(error) } : {}),
  } satisfies WorkerToMainMessage);
} finally {
  port.close();
}

function diagnosticMessage(error: unknown): string {
  const value = error instanceof Error ? error.stack ?? error.message : String(error);
  return value.slice(0, 4_000);
}
