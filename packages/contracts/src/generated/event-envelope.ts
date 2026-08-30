/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * Fact envelope per docs/architecture/event-contracts.md §7. event_id is stable across redeliveries (identity of the fact, not the delivery) — the key asymmetry vs the command envelope's message_id.
 */
export interface EventEnvelope {
  /**
   * Identity of the fact. Stable across redeliveries — a producer that regenerates this for a retry is a defect.
   */
  event_id: string;
  /**
   * One of the 36 names fixed by event-contracts.md §12 — no others exist. Adding one is an architecture change (context.md amendment), not an application change.
   */
  event_type:
    | 'book.uploaded'
    | 'book.parse_started'
    | 'book.parsed'
    | 'book.parse_failed'
    | 'book.structure_ready'
    | 'book.analysis_completed'
    | 'character.discovered'
    | 'character.merged'
    | 'character.confirmed'
    | 'voice.version_created'
    | 'voice.preview_requested'
    | 'voice.preview_ready'
    | 'voice.approved'
    | 'voice.locked'
    | 'director.started'
    | 'director.chunk_completed'
    | 'director.completed'
    | 'director.failed'
    | 'tts.started'
    | 'tts.chunk_completed'
    | 'tts.chunk_failed'
    | 'tts.completed'
    | 'audio.validated'
    | 'audio.validation_failed'
    | 'chapter.assembly_started'
    | 'chapter.completed'
    | 'audiobook.assembly_started'
    | 'audiobook.completed'
    | 'audiobook.failed'
    | 'job.created'
    | 'job.started'
    | 'job.progress'
    | 'job.retrying'
    | 'job.failed'
    | 'job.cancelled'
    | 'job.dead_lettered';
  /**
   * MAJOR.MINOR of this event_type's payload schema, independent of API version and IR version.
   */
  schema_version: string;
  /**
   * The producing transaction's commit time, not publish time.
   */
  occurred_at: string;
  correlation_id: string;
  /**
   * message_id of the command that produced this fact, or event_id of a triggering event.
   */
  causation_id: string;
  tenant_id: string;
  /**
   * Absent only for tenant-scoped events.
   */
  book_id?: string;
  /**
   * Present on every event about book content.
   */
  book_version_id?: string;
  /**
   * Absent for facts produced synchronously (e.g. voice.approved).
   */
  job_id?: string;
  producer: string;
  producer_version: string;
  /**
   * W3C trace-context string. SHOULD be present, not required.
   */
  traceparent?: string;
  /**
   * Type-specific. Identifiers and small facts only — never bulk content.
   */
  payload: {};
}
