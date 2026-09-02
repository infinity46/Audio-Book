/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface UpdateAudioScriptChunk {
  performance?: {
    speaker_type?: 'NARRATOR' | 'CHARACTER' | 'UNKNOWN' | 'SYSTEM';
    character_id?: string | null;
    is_dialogue?: boolean;
    delivery_mode?:
      'NORMAL' | 'INTERNAL_THOUGHT' | 'WHISPER' | 'SHOUT' | 'LAUGHING' | 'CRYING' | 'SINGING' | 'READING_ALOUD';
    emotion?:
      | 'NEUTRAL'
      | 'HAPPY'
      | 'SAD'
      | 'GRIEF'
      | 'ANGRY'
      | 'FEARFUL'
      | 'SURPRISED'
      | 'DISGUSTED'
      | 'EXCITED'
      | 'CALM'
      | 'TENSE'
      | 'ANXIOUS'
      | 'SOMBER'
      | 'CONFIDENT'
      | 'UNCERTAIN'
      | 'PLAYFUL'
      | 'SERIOUS';
    emotion_intensity?: number;
    pacing?: number;
    pitch?: number;
    volume?: number;
    pauses?: {
      position: 'LEADING' | 'TRAILING' | 'OFFSET';
      offset_chars?: number | null;
      duration_ms: number;
      kind?: 'BEAT' | 'SENTENCE' | 'PARAGRAPH' | 'DRAMATIC' | 'SCENE_TRANSITION' | 'SPEAKER_TRANSITION';
      breath?: 'NONE' | 'NATURAL' | 'AUDIBLE' | 'HEAVY';
    }[];
    emphasis?: {
      offset_chars: number;
      length_chars: number;
      strength: number;
    }[];
    non_verbal?: {
      offset_chars: number;
      length_chars: number;
      expression: 'LAUGH' | 'SIGH' | 'GASP' | 'SOB' | 'GROAN' | 'BREATH' | 'THROAT_CLEAR' | 'HESITATION';
      intensity: number;
      placement: 'BEFORE' | 'AFTER' | 'OVERLAY';
    }[];
  };
  voice_binding?: {
    voice_profile_id?: string;
    voice_profile_version_id?: string;
  };
  generation_control?: {
    tts_provider_id?: string;
    seed?: number | null;
    target_sample_rate?: number | null;
    target_channels?: number | null;
  };
  quality?: {
    review_flags?: (
      | 'DIRECTOR_FALLBACK'
      | 'UNKNOWN_SPEAKER'
      | 'LOW_CONFIDENCE'
      | 'CHARACTER_METADATA_CHANGED'
      | 'PRONUNCIATION_LEXICON_CHANGED'
      | 'CAPABILITY_GAP'
      | 'TEXT_HASH_MISMATCH'
    )[];
  };
  reason?: string;
}
