-- Phase 8 read-model indexes.
--
-- WHY THIS EXISTS
--
-- The Phase 8 application layer adds two hot read paths that Phases 1-7 never
-- exercised, and an index audit (§87 of the Phase 8 brief) found that neither
-- was served by an existing index:
--
--   1. GET /api/v1/books/{id}/progress aggregates unit counts per stage
--      (parsed pages, scenes, script chunks, audio chunks, chapter audio).
--      Without these, every poll is a sequential scan of the largest tables in
--      the system — on a 100-chapter, 10 000-segment book that is millions of
--      rows per request, which §90 explicitly forbids.
--   2. GET /api/v1/books/{id}/events and /jobs/{id}/events tail
--      `outbox_message` once per second per open stream. Unindexed, each tick
--      scans the whole event log, and the cost grows with every event the
--      system has ever produced.
--
-- All of these are ADDITIVE and CONCURRENT-safe in shape (no column changes, no
-- rewrites, no constraint changes), so they are backward-compatible with
-- running application code: existing queries keep their existing plans, and
-- rollback is a DROP INDEX.
--
-- CREATE INDEX (not CONCURRENTLY): Prisma runs each migration inside a
-- transaction, and CONCURRENTLY cannot run in one. On a populated production
-- database these should be applied as CONCURRENTLY by an operator outside the
-- migration runner; the statements are written so that doing so is a
-- one-keyword edit, and IF NOT EXISTS makes the migration a no-op afterwards.

-- --- Progress read model: per-stage unit counts -----------------------------

-- Ingestion: `parsed_page` grouped by status for one book.
CREATE INDEX IF NOT EXISTS "parsed_page_book_id_status_idx"
  ON "parsed_page" ("book_id", "status");

-- Analysis: scene and scene-semantics counts for one book.
CREATE INDEX IF NOT EXISTS "scene_book_id_idx"
  ON "scene" ("book_id");
CREATE INDEX IF NOT EXISTS "scene_semantics_book_id_idx"
  ON "scene_semantics" ("book_id");

-- Assembly: chapter count for one book (the denominator).
CREATE INDEX IF NOT EXISTS "chapter_book_id_idx"
  ON "chapter" ("book_id");

-- Director: current script chunk count, and the flagged subset that feeds
-- `needs_review_count`. Partial on `is_current` because every count in the
-- progress model is over the current generation only — superseded rows are
-- history, and including them would make progress fall after a regeneration.
CREATE INDEX IF NOT EXISTS "audio_script_chunk_book_current_idx"
  ON "audio_script_chunk" ("book_id") WHERE "is_current";
CREATE INDEX IF NOT EXISTS "audio_script_chunk_book_flagged_idx"
  ON "audio_script_chunk" ("book_id") WHERE "is_current" AND "has_review_flags";

-- TTS: audio chunks grouped by status for one book.
CREATE INDEX IF NOT EXISTS "audio_chunk_book_status_current_idx"
  ON "audio_chunk" ("book_id", "status") WHERE "is_current";

-- Current-pointer lookups the progress model performs on every call.
CREATE INDEX IF NOT EXISTS "book_version_book_current_idx"
  ON "book_version" ("book_id") WHERE "is_current";
CREATE INDEX IF NOT EXISTS "audio_script_book_current_idx"
  ON "audio_script" ("book_id") WHERE "is_current";

-- --- SSE event streams (api-specification.md §16.19) ------------------------
--
-- Tenant-first so the index enforces the scoping the query does: a stream may
-- only ever read its own tenant's events, and leading with `tenant_id` means a
-- plan that ignored the filter could not use the index at all.

CREATE INDEX IF NOT EXISTS "outbox_message_book_stream_idx"
  ON "outbox_message" ("tenant_id", "book_id", "created_at")
  WHERE "book_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "outbox_message_job_stream_idx"
  ON "outbox_message" ("tenant_id", "job_id", "created_at")
  WHERE "job_id" IS NOT NULL;

-- --- Audit trail read path ---------------------------------------------------
--
-- `audit_log` already indexes (tenant_id, occurred_at), (resource_type,
-- resource_id, occurred_at) and (actor_user_id, occurred_at); Phase 8 adds no
-- query shape those do not cover, so no index is added here. Recorded so the
-- omission is visibly deliberate rather than an oversight.
