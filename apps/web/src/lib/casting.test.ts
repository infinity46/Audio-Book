import { describe, expect, it } from 'vitest';
import { buildCastingIndex } from './casting';
import { makeCasting, makeCharacters, CHARACTER_ID } from '@/test/msw/fixtures';

/**
 * The derivation that avoids one request per character: a speaking character
 * absent from `casting.blocking` is, by that endpoint's own construction,
 * assigned and approved.
 */
describe('buildCastingIndex', () => {
  const characters = makeCharacters();
  const statusFor = buildCastingIndex(makeCasting());

  it('reports a speaking character absent from blocking as ready', () => {
    const ready = characters.find((c) => c.id === CHARACTER_ID)!;
    expect(statusFor(ready).status).toBe('READY');
  });

  it('distinguishes "no voice" from "voice not approved"', () => {
    // The two reasons need different remedies, so they must not be collapsed.
    expect(statusFor(characters.find((c) => c.id === `${CHARACTER_ID}-1`)!).status).toBe('NO_VOICE');
    expect(statusFor(characters.find((c) => c.id === `${CHARACTER_ID}-2`)!).status).toBe(
      'VOICE_NOT_APPROVED',
    );
  });

  it('needs no voice for a non-speaking character', () => {
    const silent = { ...characters[0]!, speaking: false };
    expect(statusFor(silent).status).toBe('NOT_REQUIRED');
  });

  it('says unknown rather than ready before casting state has loaded', () => {
    // Reporting READY on missing data would tell a user generation is possible
    // when it may not be.
    const withoutCasting = buildCastingIndex(undefined);
    expect(withoutCasting(characters[0]!).status).toBe('UNKNOWN');
  });

  it('treats an unrecognized blocking reason as still blocking', () => {
    const index = buildCastingIndex(
      makeCasting({
        blocking: [
          { character_id: CHARACTER_ID, display_name: 'Marlow', line_count: 1, reason: 'SOME_NEW_REASON' },
        ],
      }),
    );
    expect(index(characters[0]!).status).toBe('VOICE_NOT_APPROVED');
  });
});
