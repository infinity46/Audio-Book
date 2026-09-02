/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface AssignVoice {
  voice_profile_id: string;
  voice_profile_version?: number;
  acknowledge_partial_revoice?: boolean;
}
