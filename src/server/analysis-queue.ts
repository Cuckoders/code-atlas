import { randomUUID } from 'node:crypto';
import type { AnalysisJob, AnalysisJobPriority, ProjectAnalysis } from '../shared/graph.js';
import { AnalysisError, type AnalyzeProjectOptions } from './analyzer.js';
import { AnalysisWorkerCancelledError, runAnalysisWorker } from './analysis-worker-runner.js';
import type { SnapshotStore } from './snapshot-store.js';

const MAX_RETAINED_JOBS = 100;
const DEFAULT_CONCURRENCY = 2;

type Analyze = (projectPath: string, options: AnalyzeProjectOptions) => Promise<ProjectAnalysis>;

export class AnalysisQueue {
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly pending: string[] = [];
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private acceptingJobs = true;
  private readonly maxConcurrent: number;

  constructor(
    private readonly snapshots: SnapshotStore,
    private readonly analyze?: Analyze,
    private readonly reportError: (error: unknown) => void = () => undefined,
    maxConcurrent = DEFAULT_CONCURRENCY,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
      throw new RangeError('Analysis concurrency must be an integer between 1 and 8');
    }
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(projectPath: string, compareRef?: string, priority: AnalysisJobPriority = 'normal'): AnalysisJob {
    if (!this.acceptingJobs) throw new Error('Analysis queue is closed');
    this.pruneJobs();
    const job: AnalysisJob = {
      id: randomUUID(),
      status: 'queued',
      priority,
      projectPath,
      ...(compareRef ? { compareRef } : {}),
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.insertPending(job.id, priority);
    this.startAvailable();
    return this.copy(job);
  }

  get(id: string): AnalysisJob | null {
    const job = this.jobs.get(id);
    return job ? this.copy(job) : null;
  }

  cancel(id: string): AnalysisJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      const pendingIndex = this.pending.indexOf(id);
      if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
      this.markCancelled(job);
    } else if (job.status === 'running') {
      this.markCancelled(job);
      this.active.get(id)?.controller.abort();
    }
    this.startAvailable();
    return this.copy(job);
  }

  async close(): Promise<void> {
    this.acceptingJobs = false;
    for (const id of [...this.pending]) this.cancel(id);
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
  }

  private insertPending(id: string, priority: AnalysisJobPriority): void {
    if (priority === 'normal') {
      this.pending.push(id);
      return;
    }
    const firstNormal = this.pending.findIndex((pendingId) => this.jobs.get(pendingId)?.priority === 'normal');
    if (firstNormal < 0) this.pending.push(id);
    else this.pending.splice(firstNormal, 0, id);
  }

  private startAvailable(): void {
    while (this.acceptingJobs && this.active.size < this.maxConcurrent && this.pending.length > 0) {
      const id = this.pending.shift();
      if (!id) continue;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.progress = { phase: 'scanning', processedFiles: 0, totalFiles: 0, percentage: 0 };
      const controller = new AbortController();
      const promise = this.processJob(job, controller.signal).finally(() => {
        this.active.delete(job.id);
        this.startAvailable();
      });
      this.active.set(job.id, { controller, promise });
    }
  }

  private async processJob(job: AnalysisJob, signal: AbortSignal): Promise<void> {
    try {
      const updateProgress: NonNullable<AnalyzeProjectOptions['onProgress']> = (progress) => {
        if (!signal.aborted) job.progress = { ...progress };
      };
      const analysis = this.analyze
        ? await this.analyze(job.projectPath, {
            compareRef: job.compareRef,
            parseCache: this.snapshots,
            onProgress: updateProgress,
            signal,
          })
        : await runAnalysisWorker(job.projectPath, job.compareRef, this.snapshots, updateProgress, signal);
      if (signal.aborted) return;
      this.snapshots.pruneParsedSources();
      const snapshot = this.snapshots.save(analysis, job.compareRef);
      job.status = 'completed';
      job.snapshotId = snapshot.id;
    } catch (error) {
      if (signal.aborted || error instanceof AnalysisWorkerCancelledError) {
        this.markCancelled(job);
        return;
      }
      job.status = 'failed';
      if (!(error instanceof AnalysisError)) this.reportError(error);
      job.error = error instanceof AnalysisError ? error.message : 'Не удалось проанализировать проект.';
    } finally {
      job.finishedAt ??= new Date().toISOString();
    }
  }

  private markCancelled(job: AnalysisJob): void {
    job.status = 'cancelled';
    job.finishedAt ??= new Date().toISOString();
    delete job.error;
  }

  private copy(job: AnalysisJob): AnalysisJob {
    return { ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) };
  }

  private pruneJobs(): void {
    if (this.jobs.size < MAX_RETAINED_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      this.jobs.delete(id);
      if (this.jobs.size < MAX_RETAINED_JOBS) break;
    }
  }
}
