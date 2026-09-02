/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface StartAssembly {
  scope: 'CHAPTER' | 'AUDIOBOOK';
  /**
   * @minItems 1
   * @maxItems 500
   */
  chapter_ids?: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 3
   */
  delivery_formats?:
    | ['M4B' | 'M4A' | 'MP3_PER_CHAPTER']
    | ['M4B' | 'M4A' | 'MP3_PER_CHAPTER', 'M4B' | 'M4A' | 'MP3_PER_CHAPTER']
    | ['M4B' | 'M4A' | 'MP3_PER_CHAPTER', 'M4B' | 'M4A' | 'MP3_PER_CHAPTER', 'M4B' | 'M4A' | 'MP3_PER_CHAPTER'];
  allow_partial_preview?: boolean;
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}
