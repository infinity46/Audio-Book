/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateVoicePreview {
  book_id?: string;
  character_id?: string;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  /**
   * @minItems 1
   * @maxItems 5
   */
  samples:
    | [
        {
          text_excerpt: string;
          emotion:
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
        }
      ]
    | [
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        }
      ]
    | [
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        }
      ]
    | [
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        }
      ]
    | [
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        },
        {
          text_excerpt: string;
          emotion:
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
        }
      ];
}
