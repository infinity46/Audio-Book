/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreatePronunciationEntry {
  surface_form: string;
  ipa?: string;
  lexicon_key?: string;
  applies_to: 'GLOBAL' | 'CHARACTER' | 'CHAPTER';
  applies_to_character_id?: string | null;
  applies_to_chapter_id?: string | null;
  notes?: string | null;
}
