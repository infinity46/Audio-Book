import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '@/test/msw/server';
import { renderInProject } from '@/test/render';
import { BOOK_ID, CHARACTER_ID, makeScriptChunk } from '@/test/msw/fixtures';
import { ReviewItem } from '../ReviewItem';

const BASE = '/bff/api/v1';
const names = new Map([[CHARACTER_ID, 'Marlow']]);

function item(overrides: Partial<React.ComponentProps<typeof ReviewItem>> = {}) {
  return (
    <ReviewItem
      bookId={BOOK_ID}
      chunk={makeScriptChunk()}
      chapterTitle="Chapter 1"
      characterNames={names}
      selected={false}
      onToggleSelected={() => {}}
      {...overrides}
    />
  );
}

describe('ReviewItem', () => {
  it('renders book text as text — never as markup', async () => {
    // Rules 123–125. The fixture text contains a <script> tag; it must appear
    // as characters on the page and never become an element.
    const { container } = renderInProject(item());

    expect(
      await screen.findByText(/<script>alert\(1\)<\/script>/, { exact: false }),
    ).toBeInTheDocument();
    // No script element was created from the book's content.
    expect(container.querySelector('script')).toBeNull();
  });

  it('names each review flag in words a user can act on', () => {
    renderInProject(item());
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
    expect(screen.getByText('Speaker not identified')).toBeInTheDocument();
  });

  it('shows the detected speaker and the director’s confidence', () => {
    renderInProject(item());
    expect(screen.getByText('Marlow')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('exposes no model reasoning', () => {
    // Rule 52: review shows the decision and its confidence, never the
    // model's internal rationale — and the API exposes none.
    const { container } = renderInProject(item());
    expect(container.textContent).not.toMatch(/reasoning|chain of thought|rationale:/i);
  });

  it('corrects the speaker through the fields the API accepts', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`${BASE}/books/:bookId/audio-script-chunks/:chunkId`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: makeScriptChunk() });
      }),
    );

    renderInProject(item());
    await userEvent.click(screen.getByRole('button', { name: 'Correct this passage' }));
    await userEvent.selectOptions(screen.getByLabelText(/Who speaks this passage/), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(body).toBeDefined());
    // Clearing the character means the narrator speaks it — both fields move
    // together, because a null character with speaker_type CHARACTER is not a
    // state the script should hold.
    expect(body).toMatchObject({
      performance: { character_id: null, speaker_type: 'NARRATOR' },
    });
  });

  it('clears the flags when marking a passage resolved, and records a reason', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`${BASE}/books/:bookId/audio-script-chunks/:chunkId`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: makeScriptChunk({ review_flags: [] }) });
      }),
    );

    renderInProject(item());
    await userEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ quality: { review_flags: [] } });
    expect(String(body?.reason)).toMatch(/reviewed/i);
  });

  it('regenerates one passage as a scoped stage command, not a retry endpoint', async () => {
    // There is deliberately no POST /jobs/{id}/retry; a user-visible "try
    // again" is a scoped stage command.
    let path: string | undefined;
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/books/:bookId/tts`, async ({ request }) => {
        path = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { data: { job: { id: 'j1', object: 'job', type: 'generate_tts_chunk', status: 'QUEUED', book_id: BOOK_ID }, accepted: { scope: 'CHUNKS', planned_unit_count: 1, skipped_unit_count: 0 } } },
          { status: 202 },
        );
      }),
    );

    renderInProject(item());
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate audio' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(path).toBe(`/bff/api/v1/books/${BOOK_ID}/tts`);
    expect(body).toMatchObject({ scope: 'CHUNKS', chunk_ids: [makeScriptChunk().id] });
  });

  it('disables editing on a frozen passage and explains why', () => {
    renderInProject(item({ chunk: makeScriptChunk({ state: 'FROZEN' }) }));
    const correct = screen.getByRole('button', { name: 'Correct this passage' });
    expect(correct).toBeDisabled();
    expect(correct).toHaveAttribute('title', expect.stringMatching(/no longer be edited/i));
  });

  it('says there is nothing to listen to when no audio has been rendered', () => {
    renderInProject(item({ chunk: makeScriptChunk({ current_audio_chunk_id: null }) }));
    expect(screen.getByText(/nothing to listen to/i)).toBeInTheDocument();
  });
});
