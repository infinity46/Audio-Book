/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface StartDirector {
  scope: 'BOOK' | 'CHAPTERS';
  /**
   * @minItems 1
   * @maxItems 500
   */
  chapter_ids?: [string, ...string[]];
  director_version?: string;
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  acknowledge_version_mixing?: boolean;
}
