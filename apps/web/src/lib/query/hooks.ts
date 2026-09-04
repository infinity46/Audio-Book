'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  del,
  getAllPages,
  getOne,
  getPage,
  getVersioned,
  newIdempotencyKey,
  patch,
  post,
  put,
} from '@/lib/api/client';
import { queryKeys } from './keys';
import { pollInterval } from './polling';
import type {
  AccessUrl,
  AcceptedCommand,
  AudioChunk,
  AudioScript,
  AudioScriptChunk,
  Audiobook,
  AudiobookProject,
  Book,
  BookFile,
  BookProgress,
  BookWithStages,
  Capabilities,
  CastingState,
  Chapter,
  ChapterAudio,
  Character,
  CharacterAlias,
  Collection,
  CurrentUser,
  Job,
  Quotas,
  Session,
  StageCommandBody,
  StageName,
  UploadSession,
  VoiceAssignment,
  VoicePreview,
  VoiceProfile,
  VoiceProfileVersion,
} from '@/lib/api/types';

/**
 * The studio's server-state hooks (Phase 9 rules 94–99).
 *
 * Server state lives here and only here: no component holds a copy of a book,
 * a job, or a progress reading in React state. Mutations invalidate by key
 * prefix (rule 97) rather than patching caches by hand.
 */

// ------------------------------------------------------------- platform ----

/**
 * `/capabilities` is the source for every limit and picker vocabulary the UI
 * renders (`api-usage-guide.md` §2 — read it once at startup instead of
 * hard-coding). It changes only on deploy, so it is cached aggressively.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: queryKeys.capabilities(),
    queryFn: () => getOne<Capabilities>('/api/v1/capabilities'),
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
  });
}

export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => getOne<CurrentUser>('/api/v1/users/me'),
    staleTime: 5 * 60_000,
  });
}

/** Fails open by contract: a `degraded: true` body with `used: null` is a 200. */
export function useQuotas() {
  return useQuery({
    queryKey: queryKeys.quotas(),
    queryFn: () => getOne<Quotas>('/api/v1/users/me/quotas'),
    staleTime: 60_000,
  });
}

/** `api-specification.md` §16.2 (Phase 10) — the caller's own active sessions, most recent first. */
export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions(),
    queryFn: () => getOne<Session[]>('/api/v1/users/me/sessions'),
    staleTime: 30_000,
  });
}

/**
 * Revokes one session. Self-only by construction — the path takes an id from
 * a list this same principal fetched, never a value a caller supplies from
 * elsewhere — and revoking the session the app is *currently* running on
 * signs the user out locally too, since the BFF's own cookie stops being
 * honoured server-side the moment its underlying session is revoked.
 */
export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => del(`/api/v1/users/me/sessions/${sessionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
    },
  });
}

// ---------------------------------------------------------------- books ----

export interface BookListFilters {
  status?: string;
  limit?: number;
  cursor?: string | null;
  includeDeleted?: boolean;
}

export function useBookList(filters: BookListFilters) {
  return useQuery({
    queryKey: queryKeys.bookList(filters as Record<string, unknown>),
    queryFn: () =>
      getPage<Book>('/api/v1/books', {
        query: {
          status: filters.status,
          limit: filters.limit ?? 25,
          cursor: filters.cursor ?? undefined,
          include_deleted: filters.includeDeleted ? 'true' : undefined,
        },
      }),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty table.
    placeholderData: (previous) => previous,
  });
}

/**
 * The project resource with its pipeline overview embedded.
 *
 * `?include=stages` returns the *same* per-stage summary `GET .../progress`
 * reports — one service produces both, so they cannot disagree — which lets an
 * overview render in one request rather than two.
 */
export function useBook(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.bookDetail(bookId),
    queryFn: () =>
      getVersioned<BookWithStages>(`/api/v1/books/${bookId}`, { query: { include: 'stages' } }),
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

/**
 * The progress read model.
 *
 * Polling adapts to whether work is running and whether a stream is attached
 * (rule 44). Nothing here fabricates movement between polls — rule 17.
 */
export function useBookProgress(
  bookId: string,
  options: { streaming?: boolean; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.bookProgress(bookId),
    queryFn: () => getOne<BookProgress>(`/api/v1/books/${bookId}/progress`),
    enabled: options.enabled ?? Boolean(bookId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data ? data.stages.some((stage) => isActiveStage(stage.status)) : true;
      return pollInterval({ active, streaming: options.streaming ?? false });
    },
  });
}

function isActiveStage(status: string): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'VALIDATING';
}

export function useBookFiles(bookId: string) {
  return useQuery({
    queryKey: queryKeys.bookFiles(bookId),
    queryFn: () => getPage<BookFile>(`/api/v1/books/${bookId}/files`),
    enabled: Boolean(bookId),
  });
}

/**
 * A book's chapters, fully enumerated.
 *
 * Bounded by one project rather than by the tenant, so walking the cursor to
 * completion is correct here — and necessary, because chapter order and audio
 * status are needed together for the player's manifest. The *rendering* is
 * virtualized (rules 22, 89); the fetch is not the part that must be lazy.
 */
export function useChapters(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.chapters(bookId),
    queryFn: () => getAllPages<Chapter>(`/api/v1/books/${bookId}/chapters`, { pageSize: 100 }),
    enabled: options?.enabled ?? Boolean(bookId),
    staleTime: 60_000,
  });
}

// ----------------------------------------------------------- characters ----

/**
 * The full cast.
 *
 * The API orders characters by `importance_rank` and offers `status`,
 * `speaking`, and `include_sentinels` as filters — but **no name search and no
 * sort parameter** (`analysis.service.ts` `listCharacters`). Search and sorting
 * in the cast view therefore operate on the fetched set, which is honest
 * because the set is complete: a book's cast is bounded (tens to low hundreds),
 * every page is fetched here, and the UI labels the control as filtering the
 * cast rather than querying the server. The missing server-side capability is
 * recorded as GAP-4.
 */
export function useCharacters(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.characters(bookId),
    queryFn: () =>
      getAllPages<Character>(`/api/v1/books/${bookId}/characters`, {
        pageSize: 100,
        query: { include_sentinels: 'true' },
      }),
    enabled: options?.enabled ?? Boolean(bookId),
    staleTime: 30_000,
  });
}

export function useCharacter(bookId: string, characterId: string) {
  return useQuery({
    queryKey: queryKeys.character(bookId, characterId),
    queryFn: () => getOne<Character>(`/api/v1/books/${bookId}/characters/${characterId}`),
    enabled: Boolean(bookId && characterId),
  });
}

export function useCharacterAliases(bookId: string, characterId: string) {
  return useQuery({
    queryKey: queryKeys.characterAliases(bookId, characterId),
    queryFn: () =>
      getPage<CharacterAlias>(`/api/v1/books/${bookId}/characters/${characterId}/aliases`),
    enabled: Boolean(bookId && characterId),
  });
}

/** Casting readiness — the precondition `POST .../tts` enforces up front. */
export function useCastingState(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.casting(bookId),
    queryFn: () => getOne<CastingState>(`/api/v1/books/${bookId}/casting`),
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

/**
 * The assignments for the whole cast.
 *
 * There is no bulk read: `GET .../characters/{id}/voice` is per character, and
 * a `404` there means "no voice assigned", which is a normal state and not an
 * error. Fetching them one by one for a 200-character cast would be 200
 * requests against the `read` bucket — so the studio reads the *casting state*
 * for readiness and resolves individual assignments lazily, on the character
 * the user actually opens. Recorded as GAP-5.
 */
export function useCharacterVoice(bookId: string, characterId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.characterVoice(bookId, characterId),
    queryFn: async () => {
      try {
        return await getOne<VoiceAssignment>(
          `/api/v1/books/${bookId}/characters/${characterId}/voice`,
        );
      } catch (error) {
        // "Not assigned" is information, not a failure.
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    enabled: enabled && Boolean(bookId && characterId),
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === 404
  );
}

// --------------------------------------------------------------- voices ----

export function useVoiceProfiles(filters: { scope?: string; language?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.voiceProfiles(filters),
    queryFn: () =>
      getAllPages<VoiceProfile>('/api/v1/voice-profiles', {
        pageSize: 100,
        query: { scope: filters.scope, language: filters.language },
      }),
    staleTime: 60_000,
  });
}

export function useVoiceVersions(voiceProfileId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.voiceVersions(voiceProfileId ?? ''),
    queryFn: () =>
      getPage<VoiceProfileVersion>(`/api/v1/voice-profiles/${voiceProfileId}/versions`, {
        query: { limit: 50 },
      }),
    enabled: Boolean(voiceProfileId),
  });
}

export function useVoicePreviews(voiceProfileId: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: queryKeys.voicePreviews(voiceProfileId ?? '', version ?? 0),
    queryFn: () =>
      getPage<VoicePreview>(
        `/api/v1/voice-profiles/${voiceProfileId}/versions/${version}/previews`,
      ),
    enabled: Boolean(voiceProfileId && version !== undefined),
  });
}

// -------------------------------------------------------------- director ----

export function useAudioScript(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.audioScript(bookId),
    queryFn: async () => {
      try {
        return await getOne<AudioScript>(`/api/v1/books/${bookId}/audio-script`);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

export interface ScriptChunkFilters {
  chapterId?: string;
  hasReviewFlags?: boolean;
  cursor?: string | null;
  limit?: number;
}

/**
 * Script chunks — the review workspace's data source.
 *
 * `has_review_flags=true` is the review queue: `api-specification.md` §15.18
 * reserves `ReviewItem` without specifying it, so there is no `/review-items`
 * endpoint and Phase 8 deliberately did not invent one. This is the surface the
 * contract actually provides (`api-usage-guide.md` §10).
 */
export function useScriptChunks(bookId: string, filters: ScriptChunkFilters) {
  return useQuery({
    queryKey: queryKeys.scriptChunks(bookId, filters as Record<string, unknown>),
    queryFn: () =>
      getPage<AudioScriptChunk>(`/api/v1/books/${bookId}/audio-script-chunks`, {
        query: {
          chapter_id: filters.chapterId,
          has_review_flags: filters.hasReviewFlags ? 'true' : undefined,
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 25,
        },
      }),
    enabled: Boolean(bookId),
    placeholderData: (previous) => previous,
  });
}

// ------------------------------------------------------------------ tts ----

export function useAudioChunks(
  bookId: string,
  filters: { status?: string; chapterId?: string; limit?: number },
) {
  return useQuery({
    queryKey: queryKeys.audioChunks(bookId, filters),
    queryFn: () =>
      getPage<AudioChunk>(`/api/v1/books/${bookId}/audio-chunks`, {
        query: {
          status: filters.status,
          chapter_id: filters.chapterId,
          limit: filters.limit ?? 25,
        },
      }),
    enabled: Boolean(bookId),
  });
}

// ------------------------------------------------------------- assembly ----

export function useChapterAudio(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.chapterAudio(bookId),
    queryFn: () =>
      getAllPages<ChapterAudio>(`/api/v1/books/${bookId}/chapter-audio`, { pageSize: 100 }),
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

/**
 * The `audiobook_project` read model.
 *
 * Note the two-step the API guide calls out (§11): this resource's lifecycle
 * field is `generation_status`, and the *audiobook* it points at has its own
 * `status`. Reading `status` on the project finds nothing — a mistake a Phase 7
 * E2E test actually made (F-25).
 */
export function useAudiobookProject(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.audiobookProject(bookId),
    queryFn: () => getOne<AudiobookProject>(`/api/v1/books/${bookId}/audiobook`),
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

/** Every version, current and superseded (rule 67). */
export function useAudiobooks(bookId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.audiobooks(bookId),
    queryFn: () => getAllPages<Audiobook>(`/api/v1/books/${bookId}/audiobooks`, { pageSize: 50 }),
    enabled: options?.enabled ?? Boolean(bookId),
  });
}

export function useAudiobook(bookId: string, audiobookId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.audiobook(bookId, audiobookId ?? ''),
    queryFn: () => getOne<Audiobook>(`/api/v1/books/${bookId}/audiobooks/${audiobookId}`),
    enabled: Boolean(bookId && audiobookId),
  });
}

// ----------------------------------------------------------------- jobs ----

export interface JobFilters {
  bookId?: string;
  status?: string;
  type?: string;
  limit?: number;
  cursor?: string | null;
  sort?: string;
}

export function useJobs(filters: JobFilters, options: { streaming?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.jobs(filters as Record<string, unknown>),
    queryFn: () =>
      getPage<Job>('/api/v1/jobs', {
        query: {
          book_id: filters.bookId,
          status: filters.status,
          type: filters.type,
          limit: filters.limit ?? 25,
          cursor: filters.cursor ?? undefined,
          sort: filters.sort ?? 'created_at:desc',
        },
      }),
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      const active = rows.some((job) => !isTerminal(job.status));
      return pollInterval({ active, streaming: options.streaming ?? false });
    },
    placeholderData: (previous) => previous,
  });
}

export function useJob(jobId: string | undefined, options: { streaming?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.job(jobId ?? ''),
    queryFn: () => getOne<Job>(`/api/v1/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const job = query.state.data;
      return pollInterval({
        active: Boolean(job && !isTerminal(job.status)),
        streaming: options.streaming ?? false,
        terminal: Boolean(job && isTerminal(job.status)),
      });
    },
  });
}

function isTerminal(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'].includes(status);
}

// ------------------------------------------------------------ mutations ----

export function useCreateBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      author?: string;
      language: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }) =>
      post<Book>('/api/v1/books', {
        body,
        // Required on expensive, state-changing POSTs. A fresh key per logical
        // operation; the same key on a retry of the *same* intent.
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas() });
    },
  });
}

/**
 * Metadata edit with optimistic concurrency.
 *
 * `If-Match` is optional in the contract but sent whenever we hold an ETag:
 * without it two open tabs silently last-write-wins over the same field, and
 * with it the second one gets `409 RESOURCE_VERSION_CONFLICT` and can merge.
 */
export function useUpdateBook(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, etag }: { body: Record<string, unknown>; etag?: string | null }) =>
      patch<Book>(`/api/v1/books/${bookId}`, { body, ifMatch: etag ?? undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
  });
}

export function useDeleteBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookId: string) => del(`/api/v1/books/${bookId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas() });
    },
  });
}

/** `api-specification.md` §16.6.2 (Phase 10) — undo a soft delete. `TENANT_OWNER` only. */
export function useRestoreBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookId: string) => post<Book>(`/api/v1/books/${bookId}/restoration`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas() });
    },
  });
}

/**
 * `api-specification.md` §16.6.3 (Phase 10) — irreversible purge.
 * `TENANT_OWNER` only, `confirm_book_id` must equal `bookId` (the caller
 * types the project's own id to confirm, mirrored server-side), and the book
 * must already be deleted with no active jobs. `202` — the actual deletion
 * runs asynchronously, so the book briefly still appears (as deleted) until
 * the purge job completes and `BookPurgeGuard` starts answering `410`.
 */
export function usePurgeBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookId, confirmBookId }: { bookId: string; confirmBookId: string }) =>
      post<{ job: { id: string } }>(`/api/v1/books/${bookId}/purge`, {
        body: { confirm_book_id: confirmBookId },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas() });
    },
  });
}

/**
 * Start a pipeline stage.
 *
 * One command shape for all five stages (`api-specification.md` §4.3). The
 * `202` asserts only that intent was persisted and work enqueued — never that
 * anything happened — so nothing downstream of this treats the response as
 * completion (rule 17).
 */
export function useStartStage(bookId: string, stage: StageName) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: StageCommandBody; idempotencyKey: string }) =>
      post<AcceptedCommand>(`/api/v1/books/${bookId}/${stage}`, { body, idempotencyKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

/**
 * Assign a voice to a character.
 *
 * The `PUT` response carries an `impact` object — how many already-rendered
 * chunks are bound to the previous version, and whether regeneration is
 * required. That is the honest basis for the warning rule 33 asks for, and it
 * comes from the server rather than from a client-side guess.
 */
export function useAssignVoice(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      characterId,
      voiceProfileId,
      voiceProfileVersion,
    }: {
      characterId: string;
      voiceProfileId: string;
      voiceProfileVersion: number;
    }) =>
      put<VoiceAssignment>(`/api/v1/books/${bookId}/characters/${characterId}/voice`, {
        body: { voice_profile_id: voiceProfileId, voice_profile_version: voiceProfileVersion },
      }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.characterVoice(bookId, variables.characterId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.casting(bookId) });
    },
  });
}

export function useClearVoice(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (characterId: string) =>
      del(`/api/v1/books/${bookId}/characters/${characterId}/voice`),
    onSuccess: (_result, characterId) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.characterVoice(bookId, characterId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.casting(bookId) });
    },
  });
}

/**
 * Request cancellation.
 *
 * Always `200`, always idempotent, and deliberately needs no `Idempotency-Key`.
 * The response is what matters: `effective: false` on a `RUNNING` job means the
 * work has **not** stopped — the worker observes the flag at its next boundary.
 * Callers must render that distinction rather than claiming "cancelled".
 */
export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, reason }: { jobId: string; reason?: string }) =>
      post<{ status: string; cancellation: { effective: boolean } }>(
        `/api/v1/jobs/${jobId}/cancellation`,
        { body: reason ? { reason } : {} },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

/**
 * Mint a short-lived signed URL for a binary.
 *
 * Deliberately a mutation, not a query: it is a `POST` that mints a fresh
 * credential on every call, is audited as `ACCESS_URL_MINTED`, and is
 * explicitly not cacheable. Nothing is stored — the URL is handed straight to
 * an `<audio>` element or a download, and a new one is minted when it expires.
 */
export function useCreateAccessUrl() {
  return useMutation({
    mutationFn: ({
      path,
      disposition,
      expiresInSeconds,
    }: {
      path: string;
      disposition?: 'INLINE' | 'ATTACHMENT';
      expiresInSeconds?: number;
    }) =>
      post<AccessUrl>(path, {
        body: {
          ...(disposition ? { disposition } : {}),
          ...(expiresInSeconds ? { expires_in_seconds: expiresInSeconds } : {}),
        },
      }),
  });
}

export function useCreateUploadSession(bookId: string) {
  return useMutation({
    mutationFn: (body: {
      file_name: string;
      declared_mime_type: string;
      declared_size_bytes: number;
      declared_content_hash: { algorithm: 'SHA256'; value: string };
      source_kind: string;
      allow_duplicate?: boolean;
    }) =>
      post<UploadSession>(`/api/v1/books/${bookId}/upload-sessions`, {
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
  });
}

export function useCompleteUploadSession(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      observedSizeBytes,
      idempotencyKey,
    }: {
      sessionId: string;
      observedSizeBytes: number;
      idempotencyKey: string;
    }) =>
      post<AcceptedCommand>(`/api/v1/books/${bookId}/upload-sessions/${sessionId}/completion`, {
        body: { observed_size_bytes: observedSizeBytes },
        idempotencyKey,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
    },
  });
}

/**
 * Adjust approved performance metadata on a script chunk.
 *
 * Permitted only while the chunk is `DRAFT`/`VALIDATED`; a frozen chunk is a
 * `409`, because the same call on a draft succeeds. Canonical book **text** is
 * never editable through any endpoint, and this app offers no control that
 * would suggest otherwise.
 */
export function useUpdateScriptChunk(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chunkId, body }: { chunkId: string; body: Record<string, unknown> }) =>
      patch<AudioScriptChunk>(`/api/v1/books/${bookId}/audio-script-chunks/${chunkId}`, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['books', bookId, 'audio-script-chunks'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookProgress(bookId) });
    },
  });
}

export function useUpdateAudiobookMetadata(bookId: string, audiobookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      patch<Audiobook>(`/api/v1/books/${bookId}/audiobooks/${audiobookId}`, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.audiobooks(bookId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.audiobookProject(bookId) });
    },
  });
}

export type { Collection, UseQueryOptions };

// ------------------------------------------------- voice library mutations ----

export function useCreateVoiceProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; scope: 'TENANT' | 'BOOK'; book_id?: string }) =>
      post<VoiceProfile>('/api/v1/voice-profiles', { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice-profiles'] });
    },
  });
}

/**
 * A new version of a voice.
 *
 * `reference_audio_consent` is **required** by the schema, and deliberately so:
 * a voice version cannot exist in this system without an explicit attestation
 * of what the voice is and who consented to it. The UI collects it as a real
 * choice rather than defaulting it.
 */
export function useCreateVoiceVersion(voiceProfileId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      post<VoiceProfileVersion>(`/api/v1/voice-profiles/${voiceProfileId}/versions`, {
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice-profiles', voiceProfileId] });
      void queryClient.invalidateQueries({ queryKey: ['voice-profiles'] });
    },
  });
}

export function useApproveVoiceVersion(voiceProfileId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, approved, note }: { version: number; approved: boolean; note?: string }) =>
      post<VoiceProfileVersion>(
        `/api/v1/voice-profiles/${voiceProfileId}/versions/${version}/approval`,
        { body: { approved, ...(note ? { note } : {}) } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice-profiles', voiceProfileId] });
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useDeleteVoiceProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (voiceProfileId: string) => del(`/api/v1/voice-profiles/${voiceProfileId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice-profiles'] });
    },
  });
}

export function useUpdateCurrentUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      display_name?: string;
      preferences?: { locale?: string; notification_email?: boolean };
    }) => patch<CurrentUser>('/api/v1/users/me', { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    },
  });
}
