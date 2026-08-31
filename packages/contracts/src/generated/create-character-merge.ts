/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateCharacterMerge {
  operation: 'MERGE' | 'SPLIT';
  losing_character_id: string;
  winning_character_id: string;
  voice_conflict_resolution?: {
    [k: string]: unknown;
  } | null;
  rebind_scope?: 'AFFECTED_CHUNKS_ONLY';
}
