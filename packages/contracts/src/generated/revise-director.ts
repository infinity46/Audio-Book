/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface ReviseDirector {
  /**
   * @minItems 1
   * @maxItems 500
   */
  chunk_ids: [string, ...string[]];
  revision_reason: 'CHARACTER_MERGED' | 'VOICE_REASSIGNED' | 'LEXICON_CHANGED' | 'USER_EDIT';
  director_version?: string;
}
