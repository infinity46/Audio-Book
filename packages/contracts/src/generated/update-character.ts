/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface UpdateCharacter {
  display_name?: string;
  status?: 'CONFIRMED' | 'RETIRED';
  importance_rank?: number;
  speaking?: boolean;
  pronoun_sets?: {
    pronouns: string;
    valid_from_spine?: number;
    valid_to_spine?: number | null;
  }[];
  speech_traits?: {
    register?: string;
    verbosity?: string;
    dialect_notes?: string;
    baseline_emotion?: string;
  };
}
