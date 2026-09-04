import type { CastingState, Character } from './api/types';
import type { Tone } from './status';

/**
 * Per-character casting status, derived from the casting read model.
 *
 * There is no bulk "voice assignments for this book" endpoint —
 * `GET .../characters/{id}/voice` is per character (GAP-5) — so reading the
 * cast's casting status naively would be one request per character. It does not
 * have to be: `GET .../casting` already returns every *blocking* character with
 * a reason, and its `speaking_character_count` fixes the denominator. A
 * speaking character absent from `blocking` is, by that endpoint's own
 * construction, assigned **and** approved.
 *
 * So this derives the whole cast's status from one request. What it cannot
 * derive is *which* voice — that needs the per-character read, which the studio
 * issues lazily for the character actually being looked at.
 */

export type CastingStatus =
  | 'NOT_REQUIRED'
  | 'NO_VOICE'
  | 'VOICE_NOT_APPROVED'
  | 'READY'
  | 'UNKNOWN';

export interface CastingStatusDisplay {
  status: CastingStatus;
  label: string;
  tone: Tone;
  description: string;
}

const DISPLAY: Record<CastingStatus, Omit<CastingStatusDisplay, 'status'>> = {
  NOT_REQUIRED: {
    label: 'No voice needed',
    tone: 'neutral',
    description: 'This character has no spoken lines, so no voice is required.',
  },
  NO_VOICE: {
    label: 'No voice',
    tone: 'warning',
    description: 'This character speaks but has no voice assigned. Audio generation is refused until it does.',
  },
  VOICE_NOT_APPROVED: {
    label: 'Voice not approved',
    tone: 'warning',
    description:
      'A voice is assigned, but its version is not approved or locked, so it cannot be used for production.',
  },
  READY: {
    label: 'Voice ready',
    tone: 'success',
    description: 'An approved voice version is bound to this character.',
  },
  UNKNOWN: {
    label: 'Unknown',
    tone: 'neutral',
    description: 'Casting readiness has not been read yet.',
  },
};

export function buildCastingIndex(casting: CastingState | undefined | null) {
  const blocking = new Map<string, string>();
  for (const entry of casting?.blocking ?? []) blocking.set(entry.character_id, entry.reason);

  return function statusFor(character: Character): CastingStatusDisplay {
    if (!character.speaking) return { status: 'NOT_REQUIRED', ...DISPLAY.NOT_REQUIRED };
    if (!casting) return { status: 'UNKNOWN', ...DISPLAY.UNKNOWN };
    const reason = blocking.get(character.id);
    if (reason === 'NO_ASSIGNMENT') return { status: 'NO_VOICE', ...DISPLAY.NO_VOICE };
    if (reason === 'ASSIGNMENT_NOT_APPROVED') {
      return { status: 'VOICE_NOT_APPROVED', ...DISPLAY.VOICE_NOT_APPROVED };
    }
    // An unrecognized reason still blocks — treat it as unapproved rather than
    // silently reporting the character as ready.
    if (reason) return { status: 'VOICE_NOT_APPROVED', ...DISPLAY.VOICE_NOT_APPROVED };
    return { status: 'READY', ...DISPLAY.READY };
  };
}
