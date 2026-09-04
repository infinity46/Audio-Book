import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '@/test/msw/server';
import { renderInProject } from '@/test/render';
import {
  BOOK_ID,
  CHARACTER_ID,
  makeCharacters,
  makeProgress,
  makeVoiceProfiles,
  VOICE_PROFILE_ID,
} from '@/test/msw/fixtures';
import { VoiceAssignmentPanel } from '../VoiceAssignmentPanel';

const BASE = '/bff/api/v1';
const character = makeCharacters()[0]!;

function panel(props: Partial<React.ComponentProps<typeof VoiceAssignmentPanel>> = {}) {
  return (
    <VoiceAssignmentPanel
      bookId={BOOK_ID}
      character={character}
      assignment={null}
      assignmentLoading={false}
      voiceProfiles={makeVoiceProfiles()}
      voicesLoading={false}
      {...props}
    />
  );
}

describe('VoiceAssignmentPanel', () => {
  it('assigns without a confirmation when no audio exists yet', async () => {
    // Warning about regeneration when there is nothing to regenerate is noise.
    let body: unknown;
    server.use(
      http.put(`${BASE}/books/:bookId/characters/:characterId/voice`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          data: {
            object: 'voice_assignment',
            book_id: BOOK_ID,
            character_id: CHARACTER_ID,
            voice_profile_id: VOICE_PROFILE_ID,
            voice_profile_version: 3,
            approval_state: 'APPROVED',
            assigned_at: '2026-08-27T15:04:03.221Z',
            impact: {
              chunks_bound_to_previous_version: 0,
              requires_regeneration: false,
              estimated_regeneration_units: 0,
            },
          },
        });
      }),
    );

    const base = makeProgress();
    renderInProject(panel(), {
      progress: makeProgress({
        stages: base.stages.map((stage) =>
          stage.stage === 'tts' ? { ...stage, completed_units: 0 } : stage,
        ),
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    await userEvent.click(buttons.find((button) => !button.hasAttribute('disabled'))!);

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ voice_profile_id: VOICE_PROFILE_ID, voice_profile_version: 3 });
  });

  it('confirms before replacing a voice once audio has been rendered', async () => {
    // Rule 33 — and the wording must not claim existing audio changes, because
    // reassignment never rewrites it.
    renderInProject(
      panel({
        assignment: {
          object: 'voice_assignment',
          book_id: BOOK_ID,
          character_id: CHARACTER_ID,
          voice_profile_id: 'other-profile',
          voice_profile_version: 1,
          approval_state: 'APPROVED',
          assigned_at: '2026-08-01T10:00:00.000Z',
        },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Change voice' }));
    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    await userEvent.click(buttons.find((button) => !button.hasAttribute('disabled'))!);

    expect(await screen.findByText(/does not alter existing audio/i)).toBeInTheDocument();
  });

  it('reports the server’s measured impact after a change, not a guess', async () => {
    server.use(
      http.put(`${BASE}/books/:bookId/characters/:characterId/voice`, () =>
        HttpResponse.json({
          data: {
            object: 'voice_assignment',
            book_id: BOOK_ID,
            character_id: CHARACTER_ID,
            voice_profile_id: VOICE_PROFILE_ID,
            voice_profile_version: 3,
            approval_state: 'APPROVED',
            assigned_at: '2026-08-27T15:04:03.221Z',
            impact: {
              chunks_bound_to_previous_version: 412,
              requires_regeneration: true,
              estimated_regeneration_units: 412,
            },
          },
        }),
      ),
    );

    const base = makeProgress();
    renderInProject(panel(), {
      progress: makeProgress({
        stages: base.stages.map((stage) =>
          stage.stage === 'tts' ? { ...stage, completed_units: 0 } : stage,
        ),
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    await userEvent.click(buttons.find((button) => !button.hasAttribute('disabled'))!);

    expect(await screen.findByText(/412 already-rendered passages/)).toBeInTheDocument();
    expect(screen.getByText(/never rewrites existing audio/i)).toBeInTheDocument();
  });

  it('says an unassigned speaking character blocks generation', () => {
    renderInProject(panel());
    expect(screen.getByText('No voice assigned')).toBeInTheDocument();
    expect(screen.getByText(/refused until every speaking character/i)).toBeInTheDocument();
  });

  it('surfaces a refusal from the API inline rather than only as a toast', async () => {
    server.use(
      http.put(`${BASE}/books/:bookId/characters/:characterId/voice`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'VOICE_LANGUAGE_MISMATCH',
              message: 'This voice version does not support the book language.',
              details: [],
              request_id: 'req-1',
              trace_id: 'trace-1',
              retryable: false,
            },
          },
          { status: 409 },
        ),
      ),
    );

    const base = makeProgress();
    renderInProject(panel(), {
      progress: makeProgress({
        stages: base.stages.map((stage) =>
          stage.stage === 'tts' ? { ...stage, completed_units: 0 } : stage,
        ),
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: /Warm Narrator/ }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this voice' });
    await userEvent.click(buttons.find((button) => !button.hasAttribute('disabled'))!);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
