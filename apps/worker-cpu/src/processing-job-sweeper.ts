import type { PrismaClient } from '@audio-book/database';
import type { Logger } from '@audio-book/logging';
import {
  enqueueProcessingJob,
  isQueueName,
  type QueueJobEnvelope,
  type QueueManager,
} from '@audio-book/queue';

export interface ProcessingJobSweeperDeps {
  prisma: PrismaClient;
  queueManager: QueueManager;
  logger: Logger;
  pollIntervalMs: number;
  batchSize: number;
  /** A row is only swept once its age exceeds this — gives the normal post-commit enqueue() call a fair chance to land first. */
  staleAfterMs: number;
  onError?: (err: unknown) => void;
}

interface RawOrphanedJobRow {
  id: string;
  tenant_id: string;
  related_resource_id: string;
  correlation_id: string;
  type: string;
  queue: string;
  max_attempts: number;
  dispatch_envelope: unknown;
}

/**
 * Recovers `ProcessingJob` rows whose Postgres transaction committed but
 * whose corresponding `queueManager.enqueue()` call never happened or never
 * landed (process crash / Redis outage between the two non-transactional
 * steps every API service performs — see `enqueueProcessingJob`). Mirrors
 * `OutboxPublisher`'s poll-loop shape (`FOR UPDATE SKIP LOCKED`,
 * `setTimeout`-based start/stop) since it exists to close the exact same
 * class of gap for the one case the outbox pattern doesn't yet cover: real
 * business job dispatch.
 *
 * Covers every job type, not just the pipeline's entry point. Each service
 * writes the envelope it intends to dispatch into `dispatch_envelope` in the
 * same transaction as the job row, so this sweeper re-dispatches from the
 * job's own recorded intent rather than re-implementing each service's
 * payload-building query a second time (which is what previously limited it
 * to `parse_book` — see QA finding F-4).
 *
 * Rows with a NULL `dispatch_envelope` are skipped, never guessed at: that is
 * either a job predating the column or one that is not queue-dispatched at
 * all, and inventing a payload for it would dispatch a job the service never
 * described. `queue`, `type` and `max_attempts` come from the row itself,
 * which is what the services pass to `enqueueProcessingJob` anyway.
 *
 * Re-enqueuing a job that actually did make it to Redis is a safe no-op:
 * every enqueue in this codebase uses the ProcessingJob's own id as the
 * deterministic BullMQ jobId, and BullMQ's addStandardJob/addDelayedJob Lua
 * scripts short-circuit on an existing jobId rather than duplicating or
 * re-running a completed job.
 */
export class ProcessingJobSweeper {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(private readonly deps: ProcessingJobSweeperDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.pollOnce()
        .catch((err: unknown) => this.deps.onError?.(err))
        .finally(() => this.scheduleNext(this.deps.pollIntervalMs));
    }, delayMs);
  }

  async pollOnce(): Promise<number> {
    return this.deps.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawOrphanedJobRow[]>`
        SELECT id, tenant_id, related_resource_id, correlation_id, type, queue,
               max_attempts, dispatch_envelope
        FROM processing_job
        WHERE status = 'CREATED' AND queued_at IS NULL
          AND dispatch_envelope IS NOT NULL
          AND created_at < now() - (${this.deps.staleAfterMs} * interval '1 millisecond')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.deps.batchSize}
      `;

      let dispatched = 0;
      for (const row of rows) {
        try {
          // The column is a Postgres enum whose values are the queue names, but
          // this arrives as a raw string; refuse rather than cast, so a future
          // queue added to the database but not to QUEUE_NAMES surfaces here
          // instead of throwing from inside BullMQ on a queue that doesn't exist.
          if (!isQueueName(row.queue)) {
            this.deps.logger.error(
              { job_id: row.id, job_type: row.type, queue: row.queue },
              'ProcessingJobSweeper: job names a queue this build does not know; leaving it for a build that does',
            );
            continue;
          }
          await enqueueProcessingJob(tx, this.deps.queueManager, {
            processingJobId: row.id,
            queue: row.queue,
            envelope: row.dispatch_envelope as QueueJobEnvelope,
            jobName: row.type,
            maxAttempts: row.max_attempts,
          });
          dispatched += 1;
          this.deps.logger.warn(
            {
              job_id: row.id,
              job_type: row.type,
              queue: row.queue,
              related_resource_id: row.related_resource_id,
            },
            'ProcessingJobSweeper: re-enqueued an orphaned job (committed but never dispatched)',
          );
        } catch (err) {
          this.deps.onError?.(err);
        }
      }

      return dispatched;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
