/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface StartTts {
  scope: 'BOOK' | 'CHAPTERS' | 'CHUNKS' | 'FILTER';
  /**
   * @minItems 1
   * @maxItems 500
   */
  chapter_ids?: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 500
   */
  chunk_ids?: [string, ...string[]];
  filter?: {
    /**
     * @minItems 1
     */
    audio_chunk_status?: [
      'PENDING' | 'GENERATING' | 'GENERATED' | 'VALIDATED' | 'ASSEMBLED' | 'FAILED' | 'INVALID' | 'SUPERSEDED',
      ...('PENDING' | 'GENERATING' | 'GENERATED' | 'VALIDATED' | 'ASSEMBLED' | 'FAILED' | 'INVALID' | 'SUPERSEDED')[]
    ];
    /**
     * @minItems 1
     */
    chapter_ids?: [string, ...string[]];
  };
  force?: boolean;
  acknowledge_partial_revoice?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}
