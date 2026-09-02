/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateVoiceProfileVersion {
  tts_provider_id: string;
  tts_model_id: string;
  tts_model_version_id: string;
  language: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  supported_languages?: [string, ...string[]];
  base_generation_params?: {};
  default_pitch?: number;
  default_volume?: number;
  default_pacing?: number;
  derive_from_version?: number;
  reference_audio_consent: {
    attested: boolean;
    subject: 'SYNTHETIC' | 'SELF' | 'THIRD_PARTY_CONSENTED';
    attestation_text?: string;
  };
}
