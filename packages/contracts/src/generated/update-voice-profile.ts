/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface UpdateVoiceProfile {
  name?: string;
  description?: string;
  /**
   * @maxItems 100
   */
  intended_character_ids?: string[];
}
