import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { makeVoiceProfiles, VOICE_PROFILE_ID } from '@/test/msw/fixtures';
import { isUsableVersion, VoiceSelector } from '../VoiceSelector';
import type { VoiceProfileVersion } from '@/lib/api/types';

function version(overrides: Partial<VoiceProfileVersion>): VoiceProfileVersion {
  return {
    id: 'v',
    object: 'voice_profile_version',
    voice_profile_id: VOICE_PROFILE_ID,
    version: 1,
    supersedes_version_id: null,
    approval_state: 'APPROVED',
    lock_state: 'UNLOCKED',
    locked_at: null,
    locked_reason: null,
    tts_provider_id: 'xtts',
    tts_model_version_id: 'mv',
    language: 'en-GB',
    supported_languages: ['en-GB'],
    base_generation_params: {},
    base_generation_params_hash: '',
    emotion_capability_map: {},
    consent: { attested: true, subject: 'SYNTHETIC' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isUsableVersion', () => {
  it('accepts an approved version in a supported language', () => {
    expect(isUsableVersion(version({}), 'en-GB').usable).toBe(true);
  });

  it('accepts a language variant of the same base language', () => {
    // The API matches on the base subtag, so en-US supports an en-GB book.
    expect(isUsableVersion(version({ supported_languages: ['en-US'] }), 'en-GB').usable).toBe(true);
  });

  it('refuses a draft version and says why', () => {
    // POST .../tts answers 409 VOICE_PROFILE_NOT_APPROVED; refusing here means
    // the reason is visible before the click, not after.
    const result = isUsableVersion(version({ approval_state: 'DRAFT' }), 'en-GB');
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/approved/i);
  });

  it('accepts a locked version even when its approval state is not APPROVED', () => {
    expect(
      isUsableVersion(version({ approval_state: 'DRAFT', lock_state: 'LOCKED' }), 'en-GB').usable,
    ).toBe(true);
  });

  it('refuses a version that does not support the book’s language', () => {
    const result = isUsableVersion(version({ supported_languages: ['de-DE'] }), 'en-GB');
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/does not support/i);
  });
});

describe('VoiceSelector', () => {
  it('loads a voice’s versions only when that voice is opened', async () => {
    // Browsing a large library must not cost one request per voice.
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={vi.fn()}
        assigning={false}
      />,
    );

    expect(screen.queryByText(/Warm Narrator · v3/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    expect(await screen.findByText('Warm Narrator · v3')).toBeInTheDocument();
  });

  it('always shows the version, never just the voice name', async () => {
    // Rule 32: the assignment binds a version, so the version is what a user
    // has to be able to see.
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={vi.fn()}
        assigning={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    expect(await screen.findByText('Warm Narrator · v3')).toBeInTheDocument();
  });

  it('disables an unusable version with the reason rather than hiding it', async () => {
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={vi.fn()}
        assigning={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));

    // v2 in the fixture is DRAFT and German — unusable for an en-GB book.
    await screen.findByText('Warm Narrator · v2');
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    const disabled = buttons.filter((button) => button.hasAttribute('disabled'));
    expect(disabled.length).toBe(1);
    expect(disabled[0]).toHaveAttribute('title', expect.stringMatching(/approved|support/i));
  });

  it('reports the assignment as a profile id and a version number', async () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={onSelect}
        assigning={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    const enabled = buttons.find((button) => !button.hasAttribute('disabled'))!;
    await userEvent.click(enabled);
    expect(onSelect).toHaveBeenCalledWith(VOICE_PROFILE_ID, 3);
  });

  it('states plainly that audio preview is unavailable rather than showing a dead play button', async () => {
    // GAP-7: preview generation exists; the byte-access endpoint does not.
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={vi.fn()}
        assigning={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    expect(await screen.findByText(/Audio preview is not available/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^play/i })).not.toBeInTheDocument();
    });
  });

  it('filters the library by name', async () => {
    renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={vi.fn()}
        assigning={false}
      />,
    );
    await userEvent.type(screen.getByLabelText('Filter voices'), 'zzz');
    expect(screen.getByText(/No voices match/)).toBeInTheDocument();
  });
});
