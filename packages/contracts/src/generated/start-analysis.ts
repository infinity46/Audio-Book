/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface StartAnalysis {
  scope: 'BOOK' | 'CHAPTERS';
  /**
   * @minItems 1
   * @maxItems 500
   */
  chapter_ids?: [string, ...string[]];
  mode: 'INCREMENTAL' | 'REBUILD';
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}
