/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateBook {
  title: string;
  author?: string;
  language: string;
  description?: string;
  metadata?: {
    series?: string;
    series_index?: number;
    publication_year?: number;
    publisher?: string;
  };
}
