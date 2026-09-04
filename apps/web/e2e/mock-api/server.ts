import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_PRIVATE_KEY_PEM } from '../fixtures/test-key';

/**
 * A stand-in for the Phase 8 application API, for the end-to-end suite.
 *
 * Deliberately **not** a static fixture: it holds mutable state and advances it
 * the way the real pipeline does — a stage command returns `202` and moves
 * progress on subsequent polls, cancellation is cooperative and reports
 * `effective: false` on a running job, casting is enforced before TTS is
 * accepted. That is what makes the E2E tests exercise the studio's real
 * behaviour under real asynchrony.
 *
 * Envelope shapes are copied from the API's own DTO mappers. Tests drive
 * specific conditions through the `/__control` routes, which exist only here.
 */

const PORT = Number(process.env.MOCK_API_PORT ?? 4010);
const NOW = '2026-08-27T15:04:03.221Z';
const CHAPTER_COUNT_LARGE = 120;
const CHARACTER_COUNT_LARGE = 60;

interface Stage {
  stage: string;
  status: string;
  progress: number | null;
  completed_units: number;
  total_units: number | null;
  failed_units: number;
  flagged_units: number;
}

interface BookState {
  id: string;
  title: string;
  author: string | null;
  language: string;
  status: string;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
  current_book_version_id: string | null;
  current_audio_script_id: string | null;
  stages: Record<string, Stage>;
  chapterCount: number;
  audiobookReady: boolean;
  audiobookVersions: number;
}

function stage(name: string, overrides: Partial<Stage> = {}): Stage {
  return {
    stage: name,
    status: 'NOT_STARTED',
    progress: null,
    completed_units: 0,
    total_units: null,
    failed_units: 0,
    flagged_units: 0,
    ...overrides,
  };
}

const state = {
  books: new Map<string, BookState>(),
  jobs: new Map<string, Record<string, unknown>>(),
  voiceAssignments: new Map<string, { profileId: string; version: number }>(),
  castingBlocking: [] as { character_id: string; display_name: string; line_count: number; reason: string }[],
  reviewFlags: new Map<string, string[]>(),
  failNext: null as { path: string; status: number; code: string } | null,
  /** Open SSE responses, per book — so state changes can be pushed like the outbox does. */
  streams: new Map<string, Set<ServerResponse>>(),
};

let eventSeq = 0;

/**
 * Pushes a domain event to every open stream for a book.
 *
 * The real API tails the durable outbox; what matters for the studio is that a
 * named frame arrives and it re-reads state. Emitting here is what lets the
 * E2E suite verify the SSE path rather than only the polling fallback.
 */
function emit(bookId: string, eventType: string): void {
  const listeners = state.streams.get(bookId);
  if (!listeners) return;
  eventSeq += 1;
  const frame =
    `id: 01J9ZEVT${String(eventSeq).padStart(6, '0')}\n` +
    `event: ${eventType}\n` +
    `data: ${JSON.stringify({
      schema_version: 'events.v1',
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      book_id: bookId,
      correlation_id: '01J9ZREQ0000000000000001',
      payload: {},
    })}\n\n`;
  for (const res of listeners) res.write(frame);
}

function emptyStages(): Record<string, Stage> {
  return {
    ingestion: stage('ingestion'),
    analysis: stage('analysis'),
    director: stage('director'),
    tts: stage('tts'),
    assembly: stage('assembly'),
  };
}

function seed(): void {
  // Open streams survive a reset — the browser owns them, not the fixture.
  state.books.clear();
  state.jobs.clear();
  state.voiceAssignments.clear();
  state.reviewFlags.clear();
  state.failNext = null;

  state.castingBlocking = [
    { character_id: 'char-2', display_name: 'Captain Reyes', line_count: 460, reason: 'NO_ASSIGNMENT' },
  ];

  state.books.set('book-ready', {
    id: 'book-ready',
    title: 'The Long Voyage',
    author: 'A. Writer',
    language: 'en-GB',
    status: 'COMPLETED',
    needs_review: false,
    created_at: NOW,
    updated_at: NOW,
    current_book_version_id: 'bv-1',
    current_audio_script_id: 'as-1',
    chapterCount: 3,
    audiobookReady: true,
    audiobookVersions: 2,
    stages: {
      ingestion: stage('ingestion', { status: 'COMPLETED', progress: 1, completed_units: 412, total_units: 412 }),
      analysis: stage('analysis', { status: 'COMPLETED', progress: 1, completed_units: 88, total_units: 88 }),
      director: stage('director', { status: 'COMPLETED', progress: 1, completed_units: 1, total_units: 1 }),
      tts: stage('tts', { status: 'COMPLETED', progress: 1, completed_units: 8420, total_units: 8420 }),
      assembly: stage('assembly', { status: 'COMPLETED', progress: 1, completed_units: 3, total_units: 3 }),
    },
  });

  state.books.set('book-scripted', {
    id: 'book-scripted',
    title: 'A Winter Crossing',
    author: 'B. Novelist',
    language: 'en-GB',
    status: 'SCRIPTED',
    needs_review: false,
    created_at: NOW,
    updated_at: NOW,
    current_book_version_id: 'bv-2',
    current_audio_script_id: 'as-2',
    chapterCount: CHAPTER_COUNT_LARGE,
    audiobookReady: false,
    audiobookVersions: 0,
    stages: {
      ingestion: stage('ingestion', { status: 'COMPLETED', progress: 1, completed_units: 900, total_units: 900 }),
      analysis: stage('analysis', { status: 'COMPLETED', progress: 1, completed_units: 240, total_units: 240 }),
      director: stage('director', { status: 'COMPLETED', progress: 1, completed_units: 1, total_units: 1 }),
      tts: stage('tts'),
      assembly: stage('assembly'),
    },
  });

  state.books.set('book-failed', {
    id: 'book-failed',
    title: 'The Broken Render',
    author: 'C. Unlucky',
    language: 'en-GB',
    status: 'FAILED',
    needs_review: false,
    created_at: NOW,
    updated_at: NOW,
    current_book_version_id: 'bv-3',
    current_audio_script_id: 'as-3',
    chapterCount: 4,
    audiobookReady: false,
    audiobookVersions: 0,
    stages: {
      ingestion: stage('ingestion', { status: 'COMPLETED', progress: 1, completed_units: 100, total_units: 100 }),
      analysis: stage('analysis', { status: 'COMPLETED', progress: 1, completed_units: 20, total_units: 20 }),
      director: stage('director', { status: 'COMPLETED', progress: 1, completed_units: 1, total_units: 1 }),
      tts: stage('tts', { status: 'FAILED', progress: 0.4, completed_units: 40, total_units: 100, failed_units: 12 }),
      assembly: stage('assembly'),
    },
  });

  state.books.set('book-review', {
    id: 'book-review',
    title: 'Voices in Doubt',
    author: 'D. Uncertain',
    language: 'en-GB',
    status: 'NEEDS_REVIEW',
    needs_review: true,
    created_at: NOW,
    updated_at: NOW,
    current_book_version_id: 'bv-4',
    current_audio_script_id: 'as-4',
    chapterCount: 5,
    audiobookReady: false,
    audiobookVersions: 0,
    stages: {
      ingestion: stage('ingestion', { status: 'COMPLETED', progress: 1, completed_units: 120, total_units: 120 }),
      analysis: stage('analysis', { status: 'COMPLETED', progress: 1, completed_units: 30, total_units: 30 }),
      director: stage('director', { status: 'COMPLETED', progress: 1, completed_units: 1, total_units: 1, flagged_units: 3 }),
      tts: stage('tts', { status: 'PARTIAL', progress: 0.8, completed_units: 80, total_units: 100, flagged_units: 3 }),
      assembly: stage('assembly'),
    },
  });

  state.reviewFlags.set('chunk-1', ['LOW_CONFIDENCE', 'UNKNOWN_SPEAKER']);
  state.reviewFlags.set('chunk-2', ['DIRECTOR_FALLBACK']);
  state.reviewFlags.set('chunk-3', ['CAPABILITY_GAP']);

  state.jobs.set('job-failed', {
    id: 'job-failed',
    object: 'job',
    type: 'generate_tts_chunk',
    status: 'FAILED',
    book_id: 'book-failed',
    parent_job_id: null,
    attempt_count: 3,
    max_attempts: 3,
    next_attempt_at: null,
    result: null,
    error: {
      code: 'TTS_PROVIDER_ERROR',
      message: 'The speech engine returned an unusable response.',
      retryable: false,
      terminal: true,
      attempt_number: 3,
    },
    created_at: NOW,
    started_at: NOW,
    completed_at: NOW,
  });
}

seed();

function bookDto(book: BookState) {
  return {
    id: book.id,
    object: 'book',
    tenant_id: 'tenant-e2e',
    title: book.title,
    author: book.author,
    language: book.language,
    description: null,
    metadata: { series: null, series_index: null, publication_year: null, publisher: null },
    status: book.status,
    pipeline_version: '1.0.0',
    needs_review: book.needs_review,
    current_book_version_id: book.current_book_version_id,
    current_audio_script_id: book.current_audio_script_id,
    current_audiobook_id: null,
    created_at: book.created_at,
    updated_at: book.updated_at,
    deleted_at: null,
    links: { self: `/api/v1/books/${book.id}` },
  };
}

function stageSummary(book: BookState) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(book.stages)) {
    out[name] = {
      status: value.status,
      progress: value.progress,
      completed_units: value.completed_units,
      total_units: value.total_units,
    };
  }
  return out;
}

function progressDto(book: BookState) {
  const stages = Object.values(book.stages);
  const measurable = stages.filter((s) => s.progress !== null);
  return {
    object: 'book_progress',
    book_id: book.id,
    book_status: book.status,
    overall_progress:
      measurable.length > 0
        ? Number((measurable.reduce((sum, s) => sum + (s.progress ?? 0), 0) / measurable.length).toFixed(4))
        : null,
    degraded: false,
    degraded_reasons: [],
    stages,
    active_job_ids: [...state.jobs.values()]
      .filter(
        (job) =>
          job.book_id === book.id &&
          !['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'].includes(String(job.status)),
      )
      .map((job) => job.id as string),
    needs_review: book.needs_review,
    needs_review_count: stages.reduce((sum, s) => sum + s.flagged_units, 0),
    estimate:
      book.stages.tts?.status === 'RUNNING'
        ? { remaining_ms: 9_420_000, confidence: 'LOW', basis: 'COMPLETED_UNIT_RATE', computed_at: NOW }
        : { remaining_ms: null, confidence: 'NONE', basis: null, computed_at: null },
    queue: { position: null, backpressure: null },
    updated_at: new Date().toISOString(),
    links: {},
  };
}

function chapters(book: BookState) {
  return Array.from({ length: book.chapterCount }, (_, index) => ({
    id: `${book.id}-ch-${index}`,
    order_index: index,
    spine_start: index * 100,
    spine_end: index * 100 + 99,
    title: `Chapter ${index + 1}`,
    matter_type: 'BODY',
    char_count: 10_000 + index,
    text_qc_outcome: 'OK',
  }));
}

function characters(book: BookState) {
  const count = book.id === 'book-scripted' ? CHARACTER_COUNT_LARGE : 6;
  return Array.from({ length: count }, (_, index) => ({
    id: index === 1 ? 'char-2' : `${book.id}-char-${index}`,
    object: 'character',
    book_id: book.id,
    display_name: index === 1 ? 'Captain Reyes' : `Character ${index + 1}`,
    status: 'ACTIVE',
    is_sentinel: false,
    sentinel_kind: null,
    importance_rank: index + 1,
    line_count: 500 - index,
    speaking: true,
    pronoun_sets: null,
    speech_traits: null,
    first_appearance: { chapter_id: null, paragraph_id: null },
    last_appearance: { chapter_id: null, paragraph_id: null },
    detection: { source: 'LLM', model_version_id: 'mv-1', confidence: 0.9, evidence_paragraph_ids: [] },
    merged_into_character_id: null,
    created_at: NOW,
    updated_at: NOW,
  }));
}

function audiobookDto(book: BookState, version: number) {
  return {
    id: `${book.id}-ab-${version}`,
    object: 'audiobook',
    book_id: book.id,
    version,
    supersedes_audiobook_id: version > 1 ? `${book.id}-ab-${version - 1}` : null,
    is_current: version === book.audiobookVersions,
    is_preview_build: false,
    status: 'READY',
    container_format: 'M4B',
    available_formats: ['M4B'],
    duration_ms: 37_800_000,
    size_bytes: 512_000_000,
    chapter_manifest: chapters(book).map((chapter, index) => ({
      chapter_id: chapter.id,
      chapter_audio_id: `${chapter.id}-audio`,
      order_index: index,
      title: chapter.title,
      start_ms: index * 12_600_000,
      duration_ms: 12_600_000,
    })),
    metadata: {
      title: book.title,
      author: book.author,
      narrator_credit: 'Synthetic narration',
      ai_narration_disclosed: true,
      series: null,
      series_index: null,
      publisher: null,
      language: book.language,
      publication_year: null,
      description: null,
    },
    cover: { present: false },
    quality: { book_wer: 0.021, chunks_flagged: 6, asr_coverage: 0.15 },
    lineage: {},
    created_at: NOW,
    links: {},
  };
}

function scriptChunks(book: BookState) {
  return [...state.reviewFlags.entries()]
    .filter(([, flags]) => flags.length > 0)
    .map(([id, flags], index) => ({
      id,
      object: 'audio_script_chunk',
      audio_script_id: 'as-1',
      book_id: book.id,
      chapter_id: `${book.id}-ch-0`,
      sequence_index: index,
      chapter_sequence_index: index,
      state: 'VALIDATED',
      content: {
        text: `Flagged passage ${index + 1}. <b>Not markup.</b> "We turn back," he said.`,
        spoken_text: null,
        language: 'en-GB',
        script: null,
      },
      performance: {
        speaker_type: 'CHARACTER',
        character_id: 'char-2',
        is_dialogue: true,
        delivery_mode: 'NORMAL',
        emotion: 'SOMBER',
        emotion_intensity: 0.6,
        pacing: 1,
        pitch: 0,
        volume: 0,
      },
      confidence: 0.42,
      review_flags: flags,
      fallback_applied: false,
      fallback_reason: null,
      capability_gaps: null,
      current_audio_chunk_id: 'audio-chunk-1',
      created_at: NOW,
      updated_at: NOW,
    }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': '01J9ZREQ0000000000000001',
    'x-trace-id': '01J9ZTRC0000000000000001',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  json(res, status, {
    error: {
      code,
      message,
      details: [],
      request_id: '01J9ZREQ0000000000000001',
      trace_id: '01J9ZTRC0000000000000001',
      retryable,
      documentation_url: null,
    },
  });
}

function collection(res: ServerResponse, data: unknown[], hasMore = false): void {
  json(res, 200, {
    data,
    page: { limit: 100, has_more: hasMore, next_cursor: null, prev_cursor: null, total: null },
  });
}

/** Safe stringification of an untyped JSON field. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;
}

/** Mints a token the studio's own `verifyToken` will accept — same key material as `e2e/support.ts#mintToken`. */
async function mintMockToken(): Promise<string> {
  const key = createPrivateKey(TEST_PRIVATE_KEY_PEM);
  return new SignJWT({ tenant_id: 'tenant-e2e', roles: ['TENANT_OWNER'], scopes: [] })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('user-e2e')
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setExpirationTime('1h')
    .sign(key);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- test control plane, never part of the real API -----------------------
  if (path === '/__control/reset') {
    seed();
    return json(res, 200, { ok: true });
  }
  if (path === '/__control/fail-next') {
    state.failNext = (await readBody(req)) as unknown as typeof state.failNext;
    return json(res, 200, { ok: true });
  }
  if (path === '/__control/advance') {
    const body = await readBody(req);
    const book = state.books.get(str(body.book_id));
    if (book) {
      const tts = book.stages.tts!;
      if (body.status) tts.status = str(body.status, tts.status);
      if (body.completed_units !== undefined) tts.completed_units = Number(body.completed_units);
      if (body.total_units !== undefined) {
        tts.total_units = body.total_units === null ? null : Number(body.total_units);
      }
      tts.progress = tts.total_units ? tts.completed_units / tts.total_units : null;
      if (body.book_status) book.status = str(body.book_status, book.status);
      if (body.job_status) {
        for (const job of state.jobs.values()) {
          if (job.book_id === book.id) job.status = str(body.job_status, String(job.status));
        }
      }
      emit(book.id, 'tts.chunk_completed');
    }
    return json(res, 200, { ok: true });
  }

  if (path.startsWith('/__storage/')) {
    res.writeHead(200, {
      'content-type': 'audio/mp4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'content-length': '0',
    });
    res.end();
    return;
  }

  // --- Phase 10 auth (api-specification.md §16.1) — unauthenticated, so
  // these run before the bearer-token gate below. Credential correctness is
  // not this mock's job (that is `apps/api/src/auth/auth.service.test.ts`'s
  // job, against the real service) — this exists to let the studio's actual
  // sign-in/registration UI complete a real round trip in the e2e suite, and
  // still honours `__control/fail-next` so a test can inject a login failure
  // the same way it injects any other failure.
  if (path === '/api/v1/auth/login' && method === 'POST') {
    if (state.failNext && '/api/v1/auth/login'.includes(state.failNext.path)) {
      const failure = state.failNext;
      state.failNext = null;
      return error(res, failure.status, failure.code, 'Injected failure for the end-to-end suite.');
    }
    const body = await readBody(req);
    if (body.client_type === 'BROWSER') {
      return json(res, 200, { data: { status: 'AUTHENTICATED' } });
    }
    const access_token = await mintMockToken();
    return json(res, 200, {
      data: {
        status: 'AUTHENTICATED',
        access_token,
        expires_in: 900,
        refresh_token: 'mock-refresh-token',
        token_type: 'Bearer',
      },
    });
  }
  if (path === '/api/v1/auth/register' && method === 'POST') {
    return json(res, 201, { data: { status: 'REGISTRATION_PENDING' } });
  }
  if (path === '/api/v1/auth/logout' && method === 'POST') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.headers.authorization?.startsWith('Bearer ')) {
    return error(res, 401, 'UNAUTHENTICATED', 'Missing bearer token.');
  }

  if (state.failNext && path.includes(state.failNext.path)) {
    const failure = state.failNext;
    state.failNext = null;
    return error(res, failure.status, failure.code, 'Injected failure for the end-to-end suite.');
  }

  if (path === '/api/v1/capabilities') {
    return json(res, 200, {
      data: {
        object: 'capabilities',
        api_version: 'v1',
        degraded: true,
        degraded_reasons: ['WORKER_CAPABILITY_REGISTRY_UNAVAILABLE'],
        limits: {
          max_page_limit: 100,
          default_page_limit: 25,
          max_request_body_bytes: 1_048_576,
          max_upload_bytes: { PDF: 209_715_200, EPUB: 209_715_200 },
          signed_url_max_expiry_seconds: 900,
          max_batch_ids: 500,
          max_pages_per_book: 2000,
        },
        upload: {
          accepted_mime_types: ['application/pdf', 'application/epub+zip'],
          multipart_threshold_bytes: null,
        },
        tts_providers: [
          {
            tts_provider_id: 'xtts',
            model_id: 'xtts-v2',
            model_version_id: 'mv-tts-1',
            version: '2.0.3',
            capabilities: null,
            available: null,
          },
        ],
        director_versions: [],
        delivery_formats: ['M4B', 'M4A', 'MP3_PER_CHAPTER'],
        vocabularies: { emotion: ['NEUTRAL', 'SOMBER'], delivery_mode: ['NORMAL', 'WHISPER'] },
        links: {},
      },
    });
  }

  if (path === '/api/v1/users/me') {
    return json(res, 200, {
      data: {
        id: 'user-e2e',
        object: 'user',
        tenant_id: 'tenant-e2e',
        email: 'producer@example.com',
        display_name: 'E2E Producer',
        roles: ['TENANT_OWNER'],
        preferences: { notification_email: false },
      },
    });
  }

  if (path === '/api/v1/users/me/quotas') {
    return json(res, 200, {
      data: {
        object: 'quota_summary',
        degraded: false,
        quotas: [{ dimension: 'CONCURRENT_BOOKS', limit: 5, used: 1 }],
      },
    });
  }

  if (path === '/api/v1/voice-profiles' && method === 'GET') {
    return collection(res, [
      {
        id: 'voice-1',
        object: 'voice_profile',
        tenant_id: 'tenant-e2e',
        scope: 'TENANT',
        book_id: null,
        name: 'Warm Narrator',
        description: 'Measured, low register.',
        active_version: 2,
        lock_state: 'UNLOCKED',
        version_count: 2,
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
  }

  if (/^\/api\/v1\/voice-profiles\/[^/]+\/versions$/.test(path) && method === 'GET') {
    return collection(res, [
      {
        id: 'voice-1-v2',
        object: 'voice_profile_version',
        voice_profile_id: 'voice-1',
        version: 2,
        supersedes_version_id: null,
        approval_state: 'APPROVED',
        lock_state: 'UNLOCKED',
        locked_at: null,
        locked_reason: null,
        tts_provider_id: 'xtts',
        tts_model_version_id: 'mv-tts-1',
        language: 'en-GB',
        supported_languages: ['en-GB'],
        base_generation_params: {},
        base_generation_params_hash: 'h',
        emotion_capability_map: {},
        consent: { attested: true, subject: 'SYNTHETIC' },
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
  }

  if (path === '/api/v1/books' && method === 'GET') {
    const statusFilter = url.searchParams.get('status');
    const wanted = statusFilter ? statusFilter.split(',') : null;
    return collection(
      res,
      [...state.books.values()].filter((book) => !wanted || wanted.includes(book.status)).map(bookDto),
    );
  }

  if (path === '/api/v1/books' && method === 'POST') {
    const body = await readBody(req);
    const id = `book-new-${state.books.size + 1}`;
    const book: BookState = {
      id,
      title: str(body.title, 'Untitled'),
      author: body.author ? str(body.author) : null,
      language: str(body.language, 'en-US'),
      status: 'CREATED',
      needs_review: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_book_version_id: null,
      current_audio_script_id: null,
      chapterCount: 0,
      audiobookReady: false,
      audiobookVersions: 0,
      stages: emptyStages(),
    };
    state.books.set(id, book);
    res.setHeader('Location', `/api/v1/books/${id}`);
    return json(res, 201, { data: bookDto(book) });
  }

  const bookMatch = /^\/api\/v1\/books\/([^/]+)(\/.*)?$/.exec(path);
  if (bookMatch) {
    const book = state.books.get(bookMatch[1]!);
    const rest = bookMatch[2] ?? '';
    if (!book) return error(res, 404, 'BOOK_NOT_FOUND', 'Book not found.');

    if (rest === '' && method === 'GET') {
      const data =
        url.searchParams.get('include') === 'stages'
          ? { ...bookDto(book), stages: stageSummary(book) }
          : bookDto(book);
      res.setHeader('ETag', '"e2e-etag"');
      return json(res, 200, { data });
    }
    if (rest === '' && method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.title === 'string') book.title = body.title;
      if ('author' in body) book.author = body.author === null ? null : str(body.author);
      book.updated_at = new Date().toISOString();
      res.setHeader('ETag', '"e2e-etag-2"');
      return json(res, 200, { data: bookDto(book) });
    }
    if (rest === '/progress') return json(res, 200, { data: progressDto(book) });
    if (rest === '/files') return collection(res, []);
    if (rest === '/chapters') return collection(res, chapters(book));
    if (rest === '/characters') return collection(res, characters(book));
    if (rest === '/casting') {
      const blocking = state.castingBlocking.filter(
        (entry) => !state.voiceAssignments.has(`${book.id}:${entry.character_id}`),
      );
      const total = characters(book).length;
      return json(res, 200, {
        data: {
          object: 'casting_state',
          book_id: book.id,
          ready_for_generation: blocking.length === 0,
          speaking_character_count: total,
          assigned_count: total - blocking.length,
          approved_count: total - blocking.length,
          blocking,
        },
      });
    }
    if (rest === '/audio-script') {
      return json(res, 200, {
        data: {
          id: 'as-1',
          object: 'audio_script',
          book_id: book.id,
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
          created_at: NOW,
          updated_at: NOW,
        },
      });
    }
    if (rest === '/audio-script-chunks') return collection(res, scriptChunks(book));
    if (/^\/audio-script-chunks\/[^/]+$/.test(rest) && method === 'PATCH') {
      const chunkId = rest.split('/')[2]!;
      const body = await readBody(req);
      const quality = body.quality as { review_flags?: string[] } | undefined;
      if (quality?.review_flags) state.reviewFlags.set(chunkId, quality.review_flags);
      return json(res, 200, { data: scriptChunks(book)[0] ?? {} });
    }
    if (rest === '/audio-chunks') return collection(res, []);
    if (rest === '/chapter-audio') return collection(res, []);
    if (rest === '/audiobook') {
      return json(res, 200, {
        data: {
          object: 'audiobook_project',
          book_id: book.id,
          generation_status: book.audiobookReady ? 'COMPLETED' : 'NOT_STARTED',
          current_audiobook_id: book.audiobookReady ? `${book.id}-ab-${book.audiobookVersions}` : null,
          current_version: book.audiobookReady ? book.audiobookVersions : null,
          version_count: book.audiobookVersions,
          chapters: chapters(book).map((chapter) => ({
            chapter_id: chapter.id,
            order_index: chapter.order_index,
            title: chapter.title,
            chapter_audio_id: book.audiobookReady ? `${chapter.id}-audio` : null,
            status: book.audiobookReady ? 'ASSEMBLED' : 'PENDING',
            duration_ms: book.audiobookReady ? 12_600_000 : null,
          })),
          totals: {
            chapters: book.chapterCount,
            chapters_assembled: book.audiobookReady ? book.chapterCount : 0,
            duration_ms: book.audiobookReady ? 37_800_000 : 0,
          },
          blocking: [],
          links: {},
        },
      });
    }
    if (rest === '/audiobooks') {
      return collection(
        res,
        Array.from({ length: book.audiobookVersions }, (_, index) => audiobookDto(book, index + 1)),
      );
    }
    if (/^\/audiobooks\/[^/]+\/access-urls$/.test(rest) && method === 'POST') {
      return json(res, 200, {
        data: {
          object: 'access_url',
          url: `http://localhost:${PORT}/__storage/audiobook.m4b`,
          method: 'GET',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          content_type: 'audio/mp4',
          size_bytes: 1024,
          content_hash: null,
        },
      });
    }
    if (/^\/audio-chunks\/[^/]+\/access-urls$/.test(rest) && method === 'POST') {
      return json(res, 200, {
        data: {
          object: 'access_url',
          url: `http://localhost:${PORT}/__storage/chunk.m4a`,
          method: 'GET',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          content_type: 'audio/mp4',
          size_bytes: 128,
          content_hash: null,
        },
      });
    }
    if (/^\/characters\/[^/]+\/voice$/.test(rest)) {
      const characterId = rest.split('/')[2]!;
      const key = `${book.id}:${characterId}`;
      if (method === 'GET') {
        const assignment = state.voiceAssignments.get(key);
        if (!assignment) return error(res, 404, 'RESOURCE_NOT_FOUND', 'No voice assigned.');
        return json(res, 200, {
          data: {
            object: 'voice_assignment',
            book_id: book.id,
            character_id: characterId,
            voice_profile_id: assignment.profileId,
            voice_profile_version: assignment.version,
            approval_state: 'APPROVED',
            assigned_at: NOW,
          },
        });
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        state.voiceAssignments.set(key, {
          profileId: str(body.voice_profile_id),
          version: Number(body.voice_profile_version ?? 1),
        });
        return json(res, 200, {
          data: {
            object: 'voice_assignment',
            book_id: book.id,
            character_id: characterId,
            voice_profile_id: str(body.voice_profile_id),
            voice_profile_version: Number(body.voice_profile_version ?? 1),
            approval_state: 'APPROVED',
            assigned_at: new Date().toISOString(),
            impact: {
              chunks_bound_to_previous_version: 0,
              requires_regeneration: false,
              estimated_regeneration_units: 0,
            },
          },
        });
      }
    }

    const stageMatch = /^\/(ingestion|analysis|director|tts|assembly)$/.exec(rest);
    if (stageMatch && method === 'POST') {
      const name = stageMatch[1]!;
      if (name === 'tts') {
        const blocking = state.castingBlocking.filter(
          (entry) => !state.voiceAssignments.has(`${book.id}:${entry.character_id}`),
        );
        if (blocking.length > 0) {
          return error(res, 409, 'CASTING_INCOMPLETE', 'Some passages have no resolvable voice.');
        }
      }
      const jobId = `job-${name}-${Date.now()}`;
      state.jobs.set(jobId, {
        id: jobId,
        object: 'job',
        type: `${name}_coordinator`,
        status: 'RUNNING',
        book_id: book.id,
        parent_job_id: null,
        attempt_count: 1,
        max_attempts: 3,
        next_attempt_at: null,
        cancellation: { requested: false, requested_at: null, requested_by: null, effective: false },
        result: null,
        error: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
      });

      const target = book.stages[name]!;
      target.status = 'RUNNING';
      if (name === 'tts') {
        target.total_units = 100;
        target.completed_units = 0;
        target.progress = 0;
        book.status = 'GENERATING';
      } else if (name === 'assembly') {
        target.total_units = book.chapterCount;
        target.completed_units = book.chapterCount;
        target.progress = 1;
        target.status = 'COMPLETED';
        book.status = 'COMPLETED';
        book.audiobookReady = true;
        book.audiobookVersions += 1;
      }

      emit(book.id, `${name}.started`);

      return json(res, 202, {
        data: {
          job: {
            id: jobId,
            object: 'job',
            type: `${name}_coordinator`,
            status: 'QUEUED',
            book_id: book.id,
            links: { self: `/api/v1/jobs/${jobId}` },
          },
          accepted: { scope: 'BOOK', planned_unit_count: 100, skipped_unit_count: 0 },
        },
      });
    }

    if (rest === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': keep-alive\n\n');
      const listeners = state.streams.get(book.id) ?? new Set<ServerResponse>();
      listeners.add(res);
      state.streams.set(book.id, listeners);
      const timer = setInterval(() => res.write(': keep-alive\n\n'), 5000);
      req.on('close', () => {
        clearInterval(timer);
        listeners.delete(res);
      });
      return;
    }
  }

  if (path === '/api/v1/jobs' && method === 'GET') {
    const bookId = url.searchParams.get('book_id');
    const statusFilter = url.searchParams.get('status');
    const wanted = statusFilter ? statusFilter.split(',') : null;
    return collection(
      res,
      [...state.jobs.values()].filter(
        (job) => (!bookId || job.book_id === bookId) && (!wanted || wanted.includes(String(job.status))),
      ),
    );
  }

  const cancelMatch = /^\/api\/v1\/jobs\/([^/]+)\/cancellation$/.exec(path);
  if (cancelMatch && method === 'POST') {
    const job = state.jobs.get(cancelMatch[1]!);
    if (!job) return error(res, 404, 'JOB_NOT_FOUND', 'Job not found.');
    // Cooperative: a RUNNING job records the request and keeps running.
    job.cancellation = {
      requested: true,
      requested_at: new Date().toISOString(),
      requested_by: 'user-e2e',
      effective: job.status !== 'RUNNING',
    };
    if (job.status !== 'RUNNING') job.status = 'CANCELLED';
    return json(res, 200, { data: { status: job.status, cancellation: job.cancellation } });
  }

  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/.exec(path);
  if (jobMatch && method === 'GET') {
    const job = state.jobs.get(jobMatch[1]!);
    if (!job) return error(res, 404, 'JOB_NOT_FOUND', 'Job not found.');
    return json(res, 200, { data: job });
  }

  return error(res, 404, 'RESOURCE_NOT_FOUND', `No route for ${method} ${path}`);
}

createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error('[mock-api] unhandled', err);
    error(res, 500, 'INTERNAL_ERROR', 'Unhandled.');
  });
}).listen(PORT, () => {
  console.log(`[mock-api] listening on http://localhost:${PORT}`);
});
