import { randomUUID } from 'node:crypto';
import type { AnalysisJob, ProjectAnalysis } from '../shared/graph.js';
import { AnalysisError, type AnalyzeProjectOptions } from './analyzer.js';
import { runAnalysisWorker } from './analysis-worker-runner.js';
import type { SnapshotStore } from './snapshot-store.js';

const MAX_RETAINED_JOBS = 100;

type Analyze = (projectPath: string, options: AnalyzeProjectOptions) => Promise<ProjectAnalysis>;

export class AnalysisQueue {
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly pending: string[] = [];
  private running: Promise<void> | null = null;
  private acceptingJobs = true;

  constructor(
    private readonly snapshots: SnapshotStore,
    private readonly analyze?: Analyze,
    private readonly reportError: (error: unknown) => void = () => undefined,
  ) {}

  enqueue(projectPath: string, compareRef?: string): AnalysisJob {
    if (!this.acceptingJobs) throw new Error('Analysis queue is closed');
    this.pruneJobs();
    const job: AnalysisJob = {
      id: randomUUID(),
      status: 'queued',
      projectPath,
      ...(compareRef ? { compareRef } : {}),
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.start();
    return { ...job };
  }

  get(id: string): AnalysisJob | null {
    const job = this.jobs.get(id);
    return job ? { ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) } : null;
  }

  async close(): Promise<void> {
    this.acceptingJobs = false;
    await this.running;
  }

  private start(): void {
    if (this.running) return;
    this.running = this.processPending().finally(() => {
      this.running = null;
      if (this.pending.length > 0 && this.acceptingJobs) this.start();
    });
  }

  private async processPending(): Promise<void> {
    while (this.pending.length > 0) {
      const id = this.pending.shift();
      if (!id) continue;
      const job = this.jobs.get(id);
      if (!job) continue;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.progress = { phase: 'scanning', processedFiles: 0, totalFiles: 0, percentage: 0 };
      try {
        const updateProgress: NonNullable<AnalyzeProjectOptions['onProgress']> = (progress) => {
          job.progress = { ...progress };
        };
        const analysis = this.analyze
          ? await this.analyze(job.projectPath, {
              compareRef: job.compareRef,
              parseCache: this.snapshots,
              onProgress: updateProgress,
            })
          : await runAnalysisWorker(job.projectPath, job.compareRef, this.snapshots, updateProgress);
        this.snapshots.pruneParsedSources();
        const snapshot = this.snapshots.save(analysis, job.compareRef);
        job.status = 'completed';
        job.snapshotId = snapshot.id;
      } catch (error) {
        job.status = 'failed';
        if (!(error instanceof AnalysisError)) this.reportError(error);
        job.error = error instanceof AnalysisError ? error.message : 'Не удалось проанализировать проект.';
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    }
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
