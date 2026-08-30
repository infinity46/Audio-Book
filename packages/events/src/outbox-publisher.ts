import type { PrismaClient } from '@audio-book/database';

export interface OutboxPublisherDeps {
  prisma: PrismaClient;
  /** Publishes one claimed row; throwing leaves the row PENDING for the next poll (at-least-once). */
  publish: (row: ClaimedOutboxRow) => Promise<void>;
  pollIntervalMs: number;
  batchSize: number;
  onError?: (err: unknown) => void;
}

export interface ClaimedOutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  schemaVersion: string;
  occurredAt: Date;
  tenantId: string;
  bookId: string | null;
  jobId: string | null;
  correlationId: string;
  causationId: string;
  traceparent: string | null;
  producer: string;
  producerVersion: string;
  payload: unknown;
  aggregateType: string;
  aggregateId: string;
}

/** Raw row shape as returned by the FOR UPDATE SKIP LOCKED query — DB column names, not the Prisma client's camelCase. */
interface RawOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  schema_version: string;
  occurred_at: Date;
  tenant_id: string;
  book_id: string | null;
  job_id: string | null;
  correlation_id: string;
  causation_id: string;
  traceparent: string | null;
  producer: string;
  producer_version: string;
  payload: unknown;
  aggregate_type: string;
  aggregate_id: string;
}

/**
 * Outbox relay (event-contracts.md §19): polls PENDING rows with
 * `FOR UPDATE SKIP LOCKED` so multiple publisher instances can run
 * concurrently without double-publishing, calls `publish` for each while
 * still holding the row lock, and only marks a row PUBLISHED after
 * `publish` resolves. If the process crashes between publish and commit,
 * the row stays PENDING and is retried — the at-least-once contract this
 * whole system is built around, made concrete at the one place that
 * actually crosses the Postgres/Redis boundary.
 */
export class OutboxPublisher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(private readonly deps: OutboxPublisherDeps) {}

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
      const rows = await tx.$queryRaw<RawOutboxRow[]>`
        SELECT id, event_id, event_type, schema_version, occurred_at, tenant_id, book_id,
               job_id, correlation_id, causation_id, traceparent, producer, producer_version,
               payload, aggregate_type, aggregate_id
        FROM outbox_message
        WHERE status = 'PENDING'
        ORDER BY aggregate_type, aggregate_id, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.deps.batchSize}
      `;

      for (const row of rows) {
        const claimed: ClaimedOutboxRow = {
          id: row.id,
          eventId: row.event_id,
          eventType: row.event_type,
          schemaVersion: row.schema_version,
          occurredAt: row.occurred_at,
          tenantId: row.tenant_id,
          bookId: row.book_id,
          jobId: row.job_id,
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          traceparent: row.traceparent,
          producer: row.producer,
          producerVersion: row.producer_version,
          payload: row.payload,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
        };

        // A failure here updates only this row's diagnostics and moves on —
        // it must NOT abort the surrounding transaction, or an earlier
        // row's already-committed PUBLISHED update in this same batch would
        // roll back too, turning one bad row into a false republish of
        // everything ahead of it. Leaving this row PENDING is enough; the
        // next poll retries it (at-least-once), and this.deps.onError
        // surfaces it for alerting.
        try {
          await this.deps.publish(claimed);
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
              publishAttempts: { increment: 1 },
            },
          });
        } catch (err) {
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: { publishAttempts: { increment: 1 }, lastError: String(err) },
          });
          this.deps.onError?.(err);
        }
      }

      return rows.length;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
