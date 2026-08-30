import type { Tx } from '@audio-book/database';
import { generateId } from './id.js';

export interface OutboxEventDraft<TPayload extends object = Record<string, unknown>> {
  eventType: string;
  schemaVersion: string;
  tenantId: string;
  bookId?: string;
  jobId?: string;
  correlationId: string;
  causationId: string;
  traceparent?: string;
  producer: string;
  producerVersion: string;
  payload: TPayload;
  /** Ordering key — event-contracts.md §19.3. Typically the aggregate's own type/id, e.g. ('book', bookId). */
  aggregateType: string;
  aggregateId: string;
}

/**
 * Writes an OutboxMessage row inside the SAME transaction as a domain state
 * change (event-contracts.md §19.2: "one DB transaction updates domain state
 * AND inserts an outbox_message row"). The message only becomes publishable
 * after that transaction commits — the caller supplies `tx` from
 * `withTransaction` and performs the domain write in the same callback.
 *
 * event_id is minted here and is the identity of the FACT — stable across
 * every redelivery the OutboxPublisher ever attempts for this row.
 */
export async function writeOutboxMessage<TPayload extends object>(
  tx: Tx,
  draft: OutboxEventDraft<TPayload>,
): Promise<{ id: string; eventId: string }> {
  const id = generateId();
  const eventId = generateId();
  await tx.outboxMessage.create({
    data: {
      id,
      eventId,
      eventType: draft.eventType,
      schemaVersion: draft.schemaVersion,
      occurredAt: new Date(),
      tenantId: draft.tenantId,
      bookId: draft.bookId,
      jobId: draft.jobId,
      correlationId: draft.correlationId,
      causationId: draft.causationId,
      traceparent: draft.traceparent,
      producer: draft.producer,
      producerVersion: draft.producerVersion,
      payload: draft.payload,
      aggregateType: draft.aggregateType,
      aggregateId: draft.aggregateId,
      status: 'PENDING',
      publishAttempts: 0,
    },
  });
  return { id, eventId };
}
