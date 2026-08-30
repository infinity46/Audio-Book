import { Prisma, type Tx } from '@audio-book/database';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export type InboxOutcome = 'PROCESSED' | 'SKIPPED' | 'FAILED';

/**
 * Runs `handler` at most once per (consumerName, eventId) pair, inside the
 * same transaction as `handler`'s own effect (event-contracts.md §20.2 —
 * this is the last-resort idempotency strategy; naturally-idempotent writes
 * or DB-constraint-backed effects should be preferred where possible, and
 * this helper reserved for side effects like sending an email that have no
 * natural idempotency of their own).
 *
 * A PRIMARY KEY violation on the EventInbox insert means "already
 * processed" and is treated as success, not an error — exactly the
 * semantics event-contracts.md §20.2 specifies.
 *
 * If `handler` throws, the error is left to propagate: `tx` came from
 * `withTransaction`, so the whole transaction — including the Inbox insert
 * below — rolls back, and the next delivery attempt sees no Inbox row and
 * retries cleanly. There is deliberately no "insert, run handler, then
 * mark FAILED on error" path — that would still roll back the mark itself,
 * so it can never be observed.
 */
export async function withInbox<T>(
  tx: Tx,
  consumerName: string,
  eventId: string,
  handler: () => Promise<T>,
): Promise<{ outcome: InboxOutcome; result?: T }> {
  try {
    await tx.eventInbox.create({
      data: { consumerName, eventId, processedAt: new Date(), outcome: 'PROCESSED' },
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return { outcome: 'SKIPPED' };
    }
    throw err;
  }

  const result = await handler();
  return { outcome: 'PROCESSED', result };
}

export async function hasBeenProcessed(
  tx: Tx,
  consumerName: string,
  eventId: string,
): Promise<boolean> {
  const row = await tx.eventInbox.findUnique({
    where: { consumerName_eventId: { consumerName, eventId } },
  });
  return row !== null && row.outcome === 'PROCESSED';
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}
