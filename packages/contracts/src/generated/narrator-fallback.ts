/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface NarratorFallback {
  accepted: boolean;
  applies_to?: 'MINOR_SPEAKERS_ONLY' | 'ALL_UNASSIGNED';
  max_line_count?: number;
}
