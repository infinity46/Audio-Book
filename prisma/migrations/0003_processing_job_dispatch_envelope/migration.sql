-- Persists the queue envelope alongside the ProcessingJob row so an orphaned
-- job (committed, but never enqueued because the process crashed or Redis was
-- unreachable between those two non-transactional steps) can be re-dispatched
-- by ProcessingJobSweeper for ANY job type, not just `parse_book`.
--
-- Nullable by design: pre-existing rows have no envelope, and a job that is
-- never queue-dispatched legitimately has none. The sweeper skips NULLs rather
-- than guessing a payload. See QA finding F-4.
ALTER TABLE "processing_job" ADD COLUMN IF NOT EXISTS "dispatch_envelope" JSONB;
