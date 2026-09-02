-- Adds `voice_preview` and `tts_job` to the `resource_type` enum.
--
-- `processing_job.result_resource_type` names the row a finished job produced.
-- `VoicePreview` and `TtsJob` are real tables, but neither was in the enum, so
-- a job whose result is one of them had no way to say so. worker-gpu wrote the
-- values anyway, which Postgres rejected:
--
--   invalid input value for enum resource_type: "voice_preview"
--
-- That made `generate_voice_preview` fail on every run (after it had already
-- rendered and uploaded the audio), and left `generate_tts_chunk` with the same
-- failure on its already-terminal/redelivery path. See QA finding F-19.
--
-- Purely additive: `ALTER TYPE ... ADD VALUE` neither rewrites existing rows nor
-- invalidates existing values, so this is backward-compatible with running
-- application code that has never emitted either value. Postgres 12+ permits it
-- inside a transaction as long as the new value is not *used* in the same
-- transaction; nothing here uses it.
--
-- IF NOT EXISTS keeps the migration idempotent against a database where an
-- operator has already added the values by hand.

ALTER TYPE "resource_type" ADD VALUE IF NOT EXISTS 'voice_preview' AFTER 'voice_profile_version';
ALTER TYPE "resource_type" ADD VALUE IF NOT EXISTS 'tts_job' AFTER 'audio_script_chunk';
