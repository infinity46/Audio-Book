/**
 * Closed vocabularies the UI renders as pickers.
 *
 * `api-usage-guide.md` §2 says to read these from `/capabilities` rather than
 * hard-coding them, and the components that can do so — the delivery-format
 * picker — do. These two are the fallback for the case where `/capabilities`
 * has not loaded yet or is degraded, and they are asserted against the API's
 * own response by `src/test/contract/vocabularies.test.ts`, so a drift is a
 * test failure rather than a silently wrong dropdown (rules 164, 165).
 *
 * Source of truth: `update-audio-script-chunk.schema.json`, which is the schema
 * the API validates these fields against.
 */

export const EMOTIONS = [
  'NEUTRAL',
  'HAPPY',
  'SAD',
  'GRIEF',
  'ANGRY',
  'FEARFUL',
  'SURPRISED',
  'DISGUSTED',
  'EXCITED',
  'CALM',
  'TENSE',
  'ANXIOUS',
  'SOMBER',
  'CONFIDENT',
  'UNCERTAIN',
  'PLAYFUL',
  'SERIOUS',
] as const;

export const DELIVERY_MODES = [
  'NORMAL',
  'INTERNAL_THOUGHT',
  'WHISPER',
  'SHOUT',
  'LAUGHING',
  'CRYING',
  'SINGING',
  'READING_ALOUD',
] as const;

export const SPEAKER_TYPES = ['NARRATOR', 'CHARACTER', 'UNKNOWN', 'SYSTEM'] as const;

export const AUDIO_CHUNK_STATUSES = [
  'PENDING',
  'GENERATING',
  'GENERATED',
  'VALIDATED',
  'ASSEMBLED',
  'FAILED',
  'INVALID',
  'SUPERSEDED',
] as const;
