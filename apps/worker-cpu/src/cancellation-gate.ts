import type { PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import { isCancellationRequested, type CancellationFlagStore } from '@audio-book/queue';

const PRODUCER = 'worker-cpu';
const PRODUCER_VERSION = '1.0.0';

export interface CancellationGateDeps {
  prisma: PrismaClient;
  flags: CancellationFlagStore;
  logger: Logger;
}

/**
 * The worker half of cooperative cancellation (`event-contracts.md` §29,
 * `context.md` §11.4).
 *
 * The API writes `processing_job.cancellation_requested` and sets a Redis
 * flag; this is the check that makes those writes mean something. Without it
 * cancelling a `RUNNING` job would set a flag nobody reads, and the API's
 * honest `cancellation.effective = false` would stay false forever.
 *
 * **Where the check happens, and where it does not.** §29.3 asks for a check
 * "before each expensive step, and at every natural unit boundary". This
 * implements the **job boundary**: before a processor starts, and therefore
 * also before every retry. That covers the cases the fast path exists for — a
 * job cancelled while queued behind a backlog, and a job cancelled between
 * attempts — and it is the check §29.3 specifies in full for
 * `generate_tts_chunk` ("before synthesis begins").
 *
 * It does **not** yet cover mid-job boundaries: cancelling a `parse_book`
 * already reading page 200 of 400 will not stop it before page 400, because
 * the ingestion pipeline takes no cancellation callback. That is a real gap,
 * bounded by one job's duration rather than by the whole book's, and it is
 * recorded as such rather than papered over — a `finally`-block check that
 * ran after the work finished would report cancellation while having burned
 * the entire cost of not cancelling.
 *
 * **A cancelled job is terminal, not failed.** Marking it `FAILED` would put
 * it in the retry path, and a cancelled job that retries itself is worse than
 * one that never stopped.
 */
export async function haltIfCancelled(
  deps: CancellationGateDeps,
  args: { jobId: string },
): Promise<boolean> {
  const job = await deps.prisma.processingJob.findUnique({
    where: { id: args.jobId },
    select: {
      id: true,
      tenantId: true,
      bookId: true,
      status: true,
      correlationId: true,
      cancellationRequested: true,
    },
  });
  // A job with no row is not this gate's problem — the processor's own
  // validation reports it, with the context to say what was missing.
  if (!job) return false;

  // Already terminal-cancelled by the API (the CREATED/QUEUED/BLOCKED/RETRYING
  // rows of §29.2): nothing further to write, but the work must not run.
  if (job.status === 'CANCELLED') return true;

  const cancelled = await isCancellationRequested(
    {
      flags: deps.flags,
      // The row was already read above, so the "durable fallback" is a lookup
      // in memory rather than a second query.
      readDurableFlag: () => Promise.resolve(job.cancellationRequested),
    },
    job.tenantId,
    job.id,
  );
  if (!cancelled) return false;

  const now = new Date();
  await withTransaction(deps.prisma, async (tx) => {
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'CANCELLED',
        statusChangedAt: now,
        completedAt: now,
        cancellationRequested: true,
        cancellationEffectiveAt: now,
      },
    });
    // Emitted here rather than by the API, because this is the moment
    // cancellation actually TAKES EFFECT — which is what §12.8 defines
    // `job.cancelled` to mean. The API emits it only for jobs it could
    // terminate outright.
    await writeOutboxMessage(tx, {
      eventType: 'job.cancelled',
      schemaVersion: 'events.v1',
      tenantId: job.tenantId,
      bookId: job.bookId ?? undefined,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'job',
      aggregateId: job.id,
      payload: {
        cancellation_effective_at: now.toISOString(),
        // §29.5: already-completed work is retained. This worker exits before
        // starting, so nothing of this attempt exists to release.
        partial_units_retained: true,
        acknowledged_by: PRODUCER,
      },
    });
  });

  deps.logger.info(
    { job_id: job.id, book_id: job.bookId },
    'Cancellation observed at job boundary — exiting before work started',
  );
  return true;
}
