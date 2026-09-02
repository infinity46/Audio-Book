/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateVoiceProfile {
  name: string;
  description?: string;
  scope: 'TENANT' | 'BOOK';
  book_id?: string;
  /**
   * @maxItems 100
   */
  intended_character_ids?: string[];
}
