/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * Command (queue job) envelope per docs/architecture/event-contracts.md §6. message_id is identity of THIS delivery — new every enqueue/retry, never reused; contrast with EventEnvelope.event_id which is stable across redeliveries.
 */
export interface CommandEnvelope {
  message_id: string;
  /**
   * One of the message types defined in context.md §11.2 (17 total). Left as an open string rather than a closed enum in Phase 1 because that document's full vocabulary was not transcribed here — enumerating a partial/guessed list would risk inventing names. Tighten to an enum once §11.2 is transcribed.
   */
  message_type: string;
  /**
   * MAJOR.MINOR of this message_type's payload schema.
   */
  schema_version: string;
  enqueued_at: string;
  correlation_id: string;
  causation_id: string;
  tenant_id: string;
  /**
   * Required except cleanup_artifacts at tenant scope.
   */
  book_id?: string;
  /**
   * Required downstream of structural analysis.
   */
  book_version_id?: string;
  /**
   * Durable identity of the work; survives every retry.
   */
  job_id: string;
  attempt: number;
  /**
   * Fencing token; a stale token is refused by the receiver.
   */
  lease_fence: number;
  /**
   * Server-derived, never client-supplied.
   */
  idempotency_key: string;
  priority: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  producer: string;
  producer_version: string;
  traceparent?: string;
  payload: {};
}
