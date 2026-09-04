import { Queue, Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { bullmqFullJitterBackoff } from './backoff.js';
import { assertQueuePayloadSizeBudget, type QueueJobEnvelope } from './job-payload.js';
import { dlqName, type QueueName } from './names.js';

export interface QueueManagerOptions {
  /** A redis:// / rediss:// connection string — see @audio-book/config's REDIS_URL. */
  redisUrl: string;
  backoff?: { baseMs: number; ceilingMs: number };
}

export interface EnqueueOptions {
  jobName: string;
  maxAttempts: number;
  priority?: number;
}

export interface WorkerOptionsInput {
  concurrency: number;
  maxAttempts: number;
}

/**
 * Thin, opinionated BullMQ wrapper. One Queue (+ matching -dlq Queue) per
 * named queue. Enforces the payload size budget on enqueue, applies the
 * full-jitter backoff formula, and moves a job to its DLQ after it
 * permanently fails (BullMQ has no native DLQ concept — this makes the
 * "one DLQ per queue, retained indefinitely" architectural requirement
 * concrete). Tracks every Queue/Worker it creates so close() can drain and
 * shut down cleanly.
 */
export class QueueManager {
  /** Shared across Queue instances (safe — Queues don't issue blocking commands). */
  private readonly connection: Redis;
  private readonly redisUrl: string;
  private readonly backoff: { baseMs: number; ceilingMs: number };
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  /** Each Worker gets its own duplicated connection (BullMQ's recommended pattern, since Workers block on BRPOPLPUSH-style reads). */
  private readonly workerConnections: Redis[] = [];

  constructor(options: QueueManagerOptions) {
    this.redisUrl = options.redisUrl;
    // BullMQ requires maxRetriesPerRequest: null on any connection it manages.
    this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.backoff = options.backoff ?? { baseMs: 1000, ceilingMs: 60_000 };
  }

  private getOrCreateQueue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  queue(name: QueueName): Queue {
    return this.getOrCreateQueue(name);
  }

  dlq(name: QueueName): Queue {
    return this.getOrCreateQueue(dlqName(name));
  }

  async enqueue<TPayload>(
    name: QueueName,
    envelope: QueueJobEnvelope<TPayload>,
    options: EnqueueOptions,
  ): Promise<Job> {
    assertQueuePayloadSizeBudget(envelope);
    // The actual backoff delay is computed by the matching Worker's
    // `settings.backoffStrategy` (see createWorker) — `type: 'custom'` here
    // just opts this job into that strategy instead of BullMQ's built-ins.
    return this.queue(name).add(options.jobName, envelope, {
      jobId: envelope.job_id,
      attempts: options.maxAttempts,
      priority: options.priority,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: false,
    });
  }

  /**
   * Removes a not-yet-running job from its queue, for the `QUEUED` /
   * `RETRYING` rows of the cancellation table (`event-contracts.md` §29.2).
   *
   * Returns `false` when the job is absent (already consumed, already removed,
   * or never enqueued) and when BullMQ refuses because the job is **active** —
   * an active job cannot be pulled out from under a worker, which is exactly
   * why cancellation of a `RUNNING` job is cooperative rather than preemptive.
   * Callers must not read `false` as failure: the durable
   * `cancellation_requested` write has already happened by then, so the worker
   * still observes the flag at its next boundary.
   */
  async removeQueuedJob(name: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(name).getJob(jobId);
    if (!job) return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a Worker for `name`, wrapping `processor` so a job that
   * exhausts its retry budget is copied onto `${name}-dlq` (never silently
   * dropped) before BullMQ marks it failed.
   */
  createWorker<TPayload>(
    name: QueueName,
    processor: Processor<QueueJobEnvelope<TPayload>>,
    options: WorkerOptionsInput,
  ): Worker {
    const workerConnection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.workerConnections.push(workerConnection);

    const worker = new Worker<QueueJobEnvelope<TPayload>>(name, processor, {
      connection: workerConnection,
      concurrency: options.concurrency,
      settings: {
        backoffStrategy: bullmqFullJitterBackoff(this.backoff.baseMs, this.backoff.ceilingMs),
      },
    });

    worker.on('failed', (job, error) => {
      if (!job) return;
      const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? options.maxAttempts);
      if (!isFinalAttempt) return;
      void this.dlq(name)
        .add(
          job.name,
          {
            ...job.data,
            dead_lettered_at: new Date().toISOString(),
            last_error: String(error?.message ?? error),
          },
          // Preserve the original job's id on its DLQ entry — without this,
          // BullMQ assigns a fresh auto-generated id and any consumer trying
          // to correlate a DLQ entry back to the job it came from (e.g. by
          // job_id) can never find it.
          { jobId: job.id, removeOnComplete: false, removeOnFail: false },
        )
        .catch(() => {
          // Failing to write to the DLQ is itself an alert condition; the worker
          // process's own logger (wired by the caller) will surface the 'error' event.
        });
    });

    this.workers.push(worker);
    return worker;
  }

  /** Graceful shutdown: stop taking new work, drain in-flight jobs, then close connections. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.workerConnections.forEach((conn) => conn.disconnect());
    this.connection.disconnect();
  }
}
