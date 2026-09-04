import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { server } from '@/test/msw/server';
import { apiError } from '@/test/msw/handlers';
import { AudioPlayer } from '../AudioPlayer';
import { useSignedAudio } from '@/lib/hooks/useSignedAudio';
import type { SignedAudio } from '@/lib/hooks/useSignedAudio';

const BASE = '/bff/api/v1';

function stubAudio(overrides: Partial<SignedAudio> = {}): SignedAudio {
  return {
    url: null,
    loading: false,
    error: null,
    resolve: vi.fn().mockResolvedValue('https://storage.example/signed.m4b'),
    invalidate: vi.fn(),
    ...overrides,
  };
}

describe('AudioPlayer', () => {
  it('fetches nothing until play is pressed', () => {
    // Rule 91 / 141: opening a page must not start downloading a 10-hour book.
    const audio = stubAudio();
    const { container } = render(<AudioPlayer audio={audio} title="Chapter 1" />);
    expect(container.querySelector('audio')).toHaveAttribute('preload', 'none');
    expect(audio.resolve).not.toHaveBeenCalled();
  });

  it('mints a signed URL only on the first play', async () => {
    const audio = stubAudio();
    render(<AudioPlayer audio={audio} title="Chapter 1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Play Chapter 1' }));
    await waitFor(() => expect(audio.resolve).toHaveBeenCalledTimes(1));
  });

  it('labels every control for assistive technology', () => {
    // Rule 85.
    render(<AudioPlayer audio={stubAudio()} title="Chapter 1" durationMsHint={600_000} />);
    expect(screen.getByRole('button', { name: 'Play Chapter 1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Seek within Chapter 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Playback speed for Chapter 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Volume for Chapter 1')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Audio player for Chapter 1/ })).toBeInTheDocument();
  });

  it('announces the scrubber position as a timecode, not as raw seconds', () => {
    render(<AudioPlayer audio={stubAudio()} title="Chapter 1" durationMsHint={3_843_000} />);
    expect(screen.getByLabelText('Seek within Chapter 1')).toHaveAttribute(
      'aria-valuetext',
      '0:00 of 1:04:03',
    );
  });

  it('reaches every control by keyboard, in transport order', async () => {
    // The scrubber is a native <input type="range">, so arrow keys, Home/End
    // and Page Up/Down come from the platform — jsdom does not implement that
    // key handling, so the real key behaviour is asserted in the Playwright
    // suite. What matters here is that nothing is unreachable by tab.
    render(<AudioPlayer audio={stubAudio()} title="Chapter 1" durationMsHint={600_000} />);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Play Chapter 1' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Seek within Chapter 1')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Playback speed for Chapter 1')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Volume for Chapter 1')).toHaveFocus();
  });

  it('commits a seek to the media element when the scrubber is released', () => {
    const { container } = render(
      <AudioPlayer audio={stubAudio()} title="Chapter 1" durationMsHint={600_000} />,
    );
    const seek = screen.getByLabelText('Seek within Chapter 1');
    fireEvent.change(seek, { target: { value: '120000' } });
    fireEvent.blur(seek);
    expect((container.querySelector('audio') as HTMLAudioElement).currentTime).toBe(120);
  });

  it('changes the playback rate on the media element', async () => {
    const { container } = render(
      <AudioPlayer audio={stubAudio()} title="Chapter 1" durationMsHint={600_000} />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Playback speed for Chapter 1'), '1.5');
    expect((container.querySelector('audio') as HTMLAudioElement).playbackRate).toBe(1.5);
  });

  it('discards a dead signed URL and offers to fetch a fresh one', async () => {
    // Rule 180: an expired link is the common failure, and re-minting is the
    // remedy — not a permanent "unavailable".
    const audio = stubAudio();
    const { container } = render(<AudioPlayer audio={audio} title="Chapter 1" />);
    const element = container.querySelector('audio')!;
    element.dispatchEvent(new Event('error'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(audio.invalidate).toHaveBeenCalled();
  });

  it('disables seeking until a duration is known', () => {
    render(<AudioPlayer audio={stubAudio()} title="Chapter 1" />);
    expect(screen.getByLabelText('Seek within Chapter 1')).toBeDisabled();
  });
});

describe('useSignedAudio', () => {
  it('mints on demand and reuses a URL that is still in date', async () => {
    let mints = 0;
    server.use(
      http.post(`${BASE}/books/b1/chapter-audio/ca1/access-urls`, () => {
        mints += 1;
        return HttpResponse.json({
          data: {
            object: 'access_url',
            url: 'https://storage.example/signed',
            method: 'GET',
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            content_type: 'audio/mp4',
            size_bytes: 1000,
            content_hash: null,
          },
        });
      }),
    );

    const { result } = renderHook(() =>
      useSignedAudio('/api/v1/books/b1/chapter-audio/ca1/access-urls'),
    );

    await result.current.resolve();
    await waitFor(() => expect(result.current.url).toBe('https://storage.example/signed'));
    await result.current.resolve();
    // A short-lived credential is minted per playback, not per press.
    expect(mints).toBe(1);
  });

  it('surfaces a refusal to mint rather than failing silently', async () => {
    server.use(
      http.post(`${BASE}/books/b1/chapter-audio/ca1/access-urls`, () =>
        apiError(409, 'ARTIFACT_NOT_READY', 'The bytes do not exist yet.'),
      ),
    );

    const { result } = renderHook(() =>
      useSignedAudio('/api/v1/books/b1/chapter-audio/ca1/access-urls'),
    );

    const url = await result.current.resolve();
    expect(url).toBeNull();
    await waitFor(() => expect(result.current.error).toBeTruthy());
  });

  it('returns nothing when there is no artifact to mint for', async () => {
    const { result } = renderHook(() => useSignedAudio(null));
    expect(await result.current.resolve()).toBeNull();
  });
});
