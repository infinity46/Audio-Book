/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface RequestIngestion {
  book_file_id: string;
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}
