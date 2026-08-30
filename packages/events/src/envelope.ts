import type { CommandEnvelope, EventEnvelope } from '@audio-book/contracts';
import { generateId } from './id.js';

export interface BuildEventEnvelopeInput<TPayload extends object = Record<string, unknown>> {
  eventType: EventEnvelope['event_type'];
  schemaVersion: string;
  tenantId: string;
  correlationId: string;
  causationId: string;
  bookId?: string;
  bookVersionId?: string;
  jobId?: string;
  producer: string;
  producerVersion: string;
  traceparent?: string;
  payload: TPayload;
  /** Defaults to now — callers persisting via Outbox should prefer the DB transaction's commit time when available. */
  occurredAt?: Date;
}

/** event_id is minted once here and must never be regenerated for retries of the same fact. */
export function buildEventEnvelope(input: BuildEventEnvelopeInput): EventEnvelope {
  return {
    event_id: generateId(),
    event_type: input.eventType,
    schema_version: input.schemaVersion,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    correlation_id: input.correlationId,
    causation_id: input.causationId,
    tenant_id: input.tenantId,
    book_id: input.bookId,
    book_version_id: input.bookVersionId,
    job_id: input.jobId,
    producer: input.producer,
    producer_version: input.producerVersion,
    traceparent: input.traceparent,
    payload: input.payload,
  };
}

export interface BuildCommandEnvelopeInput<TPayload extends object = Record<string, unknown>> {
  messageType: string;
  schemaVersion: string;
  tenantId: string;
  correlationId: string;
  causationId: string;
  jobId: string;
  bookId?: string;
  bookVersionId?: string;
  attempt: number;
  leaseFence: number;
  idempotencyKey: string;
  priority: CommandEnvelope['priority'];
  producer: string;
  producerVersion: string;
  traceparent?: string;
  payload: TPayload;
}

/** message_id is new on every call — one per delivery, including retries. */
export function buildCommandEnvelope(input: BuildCommandEnvelopeInput): CommandEnvelope {
  return {
    message_id: generateId(),
    message_type: input.messageType,
    schema_version: input.schemaVersion,
    enqueued_at: new Date().toISOString(),
    correlation_id: input.correlationId,
    causation_id: input.causationId,
    tenant_id: input.tenantId,
    book_id: input.bookId,
    book_version_id: input.bookVersionId,
    job_id: input.jobId,
    attempt: input.attempt,
    lease_fence: input.leaseFence,
    idempotency_key: input.idempotencyKey,
    priority: input.priority,
    producer: input.producer,
    producer_version: input.producerVersion,
    traceparent: input.traceparent,
    payload: input.payload,
  };
}

/**
 * Builds the next retry's envelope: new message_id, incremented attempt,
 * everything else (job_id, correlation_id, causation_id, lease_fence caller
 * must re-supply from the fresh lease) carried forward unchanged — a retry
 * never mints a new correlation_id or job_id (event-contracts.md §9.4).
 */
export function nextAttemptEnvelope(
  previous: CommandEnvelope,
  leaseFence: number,
): CommandEnvelope {
  return {
    ...previous,
    message_id: generateId(),
    enqueued_at: new Date().toISOString(),
    attempt: previous.attempt + 1,
    lease_fence: leaseFence,
  };
}
