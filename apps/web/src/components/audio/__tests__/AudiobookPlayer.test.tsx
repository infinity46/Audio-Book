import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '@/test/msw/server';
import { renderWithProviders } from '@/test/render';
import { AUDIOBOOK_ID, BOOK_ID, makeAudiobook } from '@/test/msw/fixtures';
import { AudiobookPlayer } from '../AudiobookPlayer';

const BASE = '/bff/api/v1';

beforeEach(() => {
  localStorage.clear();
});

describe('AudiobookPlayer', () => {
  it('plays one artifact and navigates chapters by seeking, not by reloading', async () => {
    // Rule 179: moving between chapters must not reset playback. One file, one
    // signed URL, chapter offsets from the manifest.
    let mints = 0;
    server.use(
      http.post(`${BASE}/books/:bookId/audiobooks/:audiobookId/access-urls`, () => {
        mints += 1;
        return HttpResponse.json({
          data: {
            object: 'access_url',
            url: 'https://storage.example/book.m4b',
            method: 'GET',
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            content_type: 'audio/mp4',
            size_bytes: 1,
            content_hash: null,
          },
        });
      }),
    );

    renderWithProviders(<AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />);

    await userEvent.click(await screen.findByRole('button', { name: /Chapter 3/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Play/ }));

    await waitFor(() => expect(mints).toBe(1));
    // Selecting another chapter does not mint a second URL — it seeks.
    await userEvent.click(screen.getByRole('button', { name: /Chapter 1/ }));
    expect(mints).toBe(1);
  });

  it('announces which chapter is playing', async () => {
    renderWithProviders(<AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />);
    expect(await screen.findByText('Now playing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Chapter 2/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Chapter 2/ })).toHaveAttribute(
        'aria-current',
        'true',
      );
    });
  });

  it('disables previous on the first chapter and next on the last, with a reason', async () => {
    renderWithProviders(<AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />);
    const previous = await screen.findByRole('button', { name: 'Previous chapter' });
    expect(previous).toBeDisabled();
    expect(previous).toHaveAttribute('title', 'This is the first chapter.');

    await userEvent.click(screen.getByRole('button', { name: /Chapter 3/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next chapter' })).toBeDisabled();
    });
  });

  it('remembers the playback position for this audiobook', async () => {
    renderWithProviders(<AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />);
    await userEvent.click(await screen.findByRole('button', { name: /Chapter 2/ }));
    await waitFor(() => {
      expect(localStorage.getItem(`audiobook-studio:position:${AUDIOBOOK_ID}`)).toBe('1800000');
    });
  });

  it('still plays when browser storage is unavailable', async () => {
    // Private windows and blocked site data throw on access rather than
    // returning null.
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    renderWithProviders(<AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />);
    expect(await screen.findByRole('button', { name: /^Play/ })).toBeInTheDocument();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
