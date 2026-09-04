import { http, HttpResponse, type HttpHandler } from 'msw';
import * as fixtures from './fixtures';

/**
 * Default handlers for the BFF surface.
 *
 * These mirror the API's envelopes exactly — `{ data }` for a resource,
 * `{ data, page }` for a collection, and the §8 error envelope for a failure —
 * so a test exercises the real client, the real error normalization, and the
 * real query layer against the real shapes.
 */

const BASE = '/bff/api/v1';

export function ok<T>(data: T) {
  return HttpResponse.json({ data });
}

export function collection<T>(data: T[], page: Partial<{ has_more: boolean; next_cursor: string | null; total: number | null }> = {}) {
  return HttpResponse.json({
    data,
    page: {
      limit: 25,
      has_more: page.has_more ?? false,
      next_cursor: page.next_cursor ?? null,
      prev_cursor: null,
      total: page.total ?? null,
    },
  });
}

/** The §8 failure envelope, exactly as `all-exceptions.filter.ts` produces it. */
export function apiError(
  status: number,
  code: string,
  message: string,
  extras: { retryable?: boolean; details?: { field?: string; issue: string }[] } = {},
) {
  return HttpResponse.json(
    {
      error: {
        code,
        message,
        details: extras.details ?? [],
        request_id: '01J9ZREQ0000000000000001',
        trace_id: '01J9ZTRC0000000000000001',
        retryable: extras.retryable ?? false,
        documentation_url: null,
      },
    },
    {
      status,
      headers: {
        'x-request-id': '01J9ZREQ0000000000000001',
        'x-trace-id': '01J9ZTRC0000000000000001',
      },
    },
  );
}

export const handlers: HttpHandler[] = [
  http.get(`${BASE}/capabilities`, () => ok(fixtures.makeCapabilities())),

  http.get(`${BASE}/users/me`, () =>
    ok({
      id: 'user-1',
      object: 'user',
      tenant_id: 'tenant-1',
      email: 'producer@example.com',
      display_name: 'A Producer',
      roles: ['TENANT_OWNER'],
      preferences: { notification_email: true },
    }),
  ),

  http.get(`${BASE}/users/me/quotas`, () =>
    ok({
      object: 'quota_summary',
      degraded: false,
      quotas: [
        { dimension: 'CONCURRENT_BOOKS', limit: 5, used: 2 },
        { dimension: 'BOOKS_TOTAL', limit: 100, used: 12 },
        { dimension: 'STORAGE_BYTES', limit: 10_737_418_240, used: 2_147_483_648 },
        { dimension: 'GPU_MINUTES', limit: null, used: null },
      ],
    }),
  ),

  http.get(`${BASE}/books`, ({ request }) => {
    const status = new URL(request.url).searchParams.get('status');
    const book = fixtures.makeBook();
    if (!status) return collection([book]);
    const wanted = status.split(',');
    return collection(wanted.includes(book.status) ? [book] : []);
  }),

  http.get(`${BASE}/books/:bookId`, ({ request }) => {
    const include = new URL(request.url).searchParams.get('include');
    const data = include === 'stages' ? fixtures.makeBookWithStages() : fixtures.makeBook();
    return HttpResponse.json({ data }, { headers: { etag: '"9f2c"' } });
  }),

  http.get(`${BASE}/books/:bookId/progress`, () => ok(fixtures.makeProgress())),
  http.get(`${BASE}/books/:bookId/files`, () => collection([])),
  http.get(`${BASE}/books/:bookId/chapters`, () => collection(fixtures.makeChapters())),
  http.get(`${BASE}/books/:bookId/characters`, () => collection(fixtures.makeCharacters())),
  http.get(`${BASE}/books/:bookId/casting`, () => ok(fixtures.makeCasting())),
  http.get(`${BASE}/books/:bookId/audio-script`, () =>
    ok({
      id: 'as-1',
      object: 'audio_script',
      book_id: fixtures.BOOK_ID,
      version: 1,
      state: 'VALIDATED',
      chunk_count: 8420,
      totals: { characters: 480_000, estimated_audio_ms: 36_000_000 },
      coverage_verified: true,
      coverage_gap_count: 0,
      unknown_speaker_rate: 0.02,
      fallback_applied_count: 3,
      low_confidence_chunk_count: 6,
      degraded: false,
      director_version: '1.2.0',
      created_at: '2026-08-20T10:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
    }),
  ),
  http.get(`${BASE}/books/:bookId/audio-script-chunks`, () =>
    collection([fixtures.makeScriptChunk()]),
  ),
  http.get(`${BASE}/books/:bookId/audio-chunks`, () => collection([])),
  http.get(`${BASE}/books/:bookId/chapter-audio`, () => collection([])),
  http.get(`${BASE}/books/:bookId/audiobook`, () => ok(fixtures.makeAudiobookProject())),
  http.get(`${BASE}/books/:bookId/audiobooks`, () => collection([fixtures.makeAudiobook()])),
  http.get(`${BASE}/books/:bookId/characters/:characterId`, () =>
    ok(fixtures.makeCharacters()[0]),
  ),
  http.get(`${BASE}/books/:bookId/characters/:characterId/aliases`, () => collection([])),
  http.get(`${BASE}/books/:bookId/characters/:characterId/voice`, () =>
    apiError(404, 'RESOURCE_NOT_FOUND', 'No voice is assigned to this character.'),
  ),

  http.get(`${BASE}/voice-profiles`, () => collection(fixtures.makeVoiceProfiles())),
  http.get(`${BASE}/voice-profiles/:id/versions`, () => collection(fixtures.makeVoiceVersions())),

  http.get(`${BASE}/jobs`, ({ request }) => {
    const status = new URL(request.url).searchParams.get('status');
    if (status?.includes('FAILED')) {
      return collection([
        fixtures.makeJob({
          status: 'FAILED',
          completed_at: '2026-08-27T14:30:00.000Z',
          error: {
            code: 'TTS_PROVIDER_ERROR',
            message: 'The speech engine returned an unusable response.',
            retryable: true,
            terminal: false,
          },
        }),
      ]);
    }
    return collection([fixtures.makeJob()]);
  }),
  http.get(`${BASE}/jobs/:jobId`, () => ok(fixtures.makeJob())),
];
