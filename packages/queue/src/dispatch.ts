import type { PrismaClient, Tx } from '@audio-book/database';
import type { QueueJobEnvelope } from './job-payload.js';
import type { QueueName } from './names.js';
import type { QueueManager } from './queue-manager.js';

export interface EnqueueProcessingJobArgs<TPayload> {
  /** The ProcessingJob row's own id — also used as the envelope's job_id / BullMQ jobId. */
  processingJobId: string;
  queue: QueueName;
  envelope: QueueJobEnvelope<TPayload>;
  jobName: string;
  maxAttempts: number;
  priority?: number;
}

/**
 * Wraps QueueManager.enqueue with the queued_at bookkeeping the
 * ProcessingJobSweeper depends on to find jobs that were committed to
 * Postgres but never made it to Redis (process crash / Redis outage between
 * the two steps). Enqueue-then-mark, not mark-then-enqueue: if the process
 * dies between the two calls, queued_at stays NULL and the row looks exactly
 * like a never-enqueued job, so the sweeper's re-enqueue is the correct
 * recovery path either way.
 *
 * Re-enqueuing a job whose envelope job_id already exists in the queue is a
 * safe no-op — every enqueue in this codebase uses the ProcessingJob's own
 * id as the deterministic BullMQ jobId, and BullMQ's addStandardJob/
 * addDelayedJob Lua scripts short-circuit on an existing jobId rather than
 * creating a duplicate or re-running a completed job.
 */
export async function enqueueProcessingJob<TPayload>(
  prisma: PrismaClient | Tx,
  queueManager: QueueManager,
  args: EnqueueProcessingJobArgs<TPayload>,
): Promise<void> {
  await queueManager.enqueue(args.queue, args.envelope, {
    jobName: args.jobName,
    maxAttempts: args.maxAttempts,
    priority: args.priority,
  });
  await prisma.processingJob.update({
    where: { id: args.processingJobId },
    data: { queuedAt: new Date() },
  });
}
