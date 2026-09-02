/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateCharacterAlias {
  surface_form: string;
  alias_type: 'GIVEN_NAME' | 'FULL_NAME' | 'SURNAME' | 'NICKNAME' | 'TITLE' | 'EPITHET' | 'DESCRIPTOR' | 'RELATIONAL';
  valid_from_spine?: number | null;
  valid_to_spine?: number | null;
  scope?: {
    kind: 'GLOBAL' | 'CHAPTER' | 'SPEAKER';
    chapter_id?: string | null;
    speaker_character_id?: string | null;
  };
}
