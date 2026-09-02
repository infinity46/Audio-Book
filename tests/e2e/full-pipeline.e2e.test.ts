import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { buildGoldenBookPdf } from '@audio-book/ingestion/test-fixtures';
import { startHarness, type E2EHarness } from './harness.js';

/**
 * The full chain, across BOTH runtimes: the TypeScript API and worker-cpu,
 * and the Python worker-ai. One document is carried from upload through
 * ingestion, narrative analysis, and Director IR generation, with every stage
 * driven over the public HTTP API and every stage's work done by a real
 * separate process consuming the real Redis queues.
 *
 * The cross-language seam is the interesting part: apps/api enqueues with the
 * Node BullMQ client and worker-ai consumes with the official BullMQ Python
 * port, against the same key layout. Nothing in the unit or integration
 * suites exercises that boundary — it is exactly the kind of place
 * `architecture-review.md` calls "the highest-probability long-term defect
 * source" (two-language contract drift).
 *
 * Inference is deterministic, not mocked away: worker-ai runs its real
 * handlers with the deterministic analyzer and Director providers, so no LLM
 * or GPU is involved but the orchestration, persistence, and validation are
 * genuine.
 *
 * Requires Postgres, Redis, MinIO, `uv`, and a prior `pnpm -r run build`.
 */
describe('Full pipeline across TypeScript and Python workers', () => {
  let harness: E2EHarness;
  let prisma: PrismaClient;

  const tenantId = generateId();
  const userId = generateId();
  let token: string;
  let bookId: string;
  let voiceProfileId: string;
  let ttsModelVersionId: string;

  async function ensureModelVersion(entry: {
    role: 'PARSER' | 'NORMALIZER' | 'LLM' | 'TTS';
    providerId: string;
    modelId: string;
    version: string;
  }): Promise<string> {
    const registry = await prisma.modelRegistry.upsert({
      where: {
        role_providerId_modelId: {
          role: entry.role,
          providerId: entry.providerId,
          modelId: entry.modelId,
        },
      },
      update: {},
      create: {
        id: generateId(),
        role: entry.role,
        providerId: entry.providerId,
        modelId: entry.modelId,
        displayName: `${entry.providerId}/${entry.modelId}`,
        status: 'ACTIVE',
      },
    });
    const existing = await prisma.modelVersion.findFirst({
      where: { modelRegistryId: registry.id, version: entry.version },
    });
    if (existing) return existing.id;
    const created = await prisma.modelVersion.create({
      data: {
        id: generateId(),
        modelRegistryId: registry.id,
        version: entry.version,
        paramsFingerprint: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
        releasedAt: new Date(),
      },
    });
    return created.id;
  }

  beforeAll(async () => {
    prisma = createPrismaClient({
      databaseUrl:
        process.env.DATABASE_URL ??
        'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook',
    });

    await prisma.tenant.create({
      data: { id: tenantId, name: 'E2E Full Pipeline Tenant', status: 'ACTIVE', planCode: 'test' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `e2e-full-${tenantId}@test.local`,
        displayName: 'E2E Pipeline User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });

    // Every stage refuses to persist without registered provenance.
    await ensureModelVersion({
      role: 'PARSER',
      providerId: 'pdfjs-dist',
      modelId: 'pdf-text-extractor',
      version: '4.9.155',
    });
    await ensureModelVersion({
      role: 'NORMALIZER',
      providerId: 'audio-book-normalizer',
      modelId: 'text-normalizer',
      version: 'normalize.v2',
    });
    await ensureModelVersion({
      role: 'LLM',
      providerId: 'audio-book-nlp',
      modelId: 'deterministic-heuristic-analyzer',
      version: '1.0.0',
    });
    await ensureModelVersion({
      role: 'LLM',
      providerId: 'audio-book-director',
      modelId: 'deterministic-heuristic-director',
      version: '1.0.0',
    });
    // worker-gpu's mock provider identity (worker_gpu/tts/providers/mock.py).
    ttsModelVersionId = await ensureModelVersion({
      role: 'TTS',
      providerId: 'mock-tts',
      modelId: 'mock-tone',
      version: 'v1',
    });
    // ffmpeg is the audio tool the assembly worker records as provenance; its
    // version has to match what the local binary actually reports.
    const { getFfmpegVersion } = await import('@audio-book/worker-cpu/lib/ffmpeg');
    await ensureModelVersion({
      role: 'AUDIO_TOOL' as never,
      providerId: 'ffmpeg',
      modelId: 'ffmpeg',
      version: await getFfmpegVersion(),
    });

    harness = await startHarness({ withWorker: true, pythonWorkers: ['ai', 'gpu'] });
    token = await harness.token({ sub: userId, tenantId, roles: ['TENANT_OWNER'] });
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
    try {
      for (const table of [
        'audiobook_rendition',
        'audiobook_chapter',
        'audiobook',
        'chapter_audio_member',
        'chapter_audio',
        'audio_chunk',
        'tts_job',
        'voice_assignment',
        'voice_preview',
        'voice_profile_version',
        'voice_profile',
        'audio_script_chunk_source',
        'audio_script_chunk',
        'audio_script',
        'scene_participant',
        'narrative_state',
        'narrative_summary',
        'scene_semantics',
        'character_relationship',
        'character_alias',
        'character',
        'story_bible_version',
        'story_bible',
        'scene',
        'paragraph',
        'section',
        'chapter',
        'parsed_page',
      ]) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }
      await prisma.$executeRaw`UPDATE book SET current_book_version_id = NULL, current_audio_script_id = NULL, current_audiobook_id = NULL WHERE tenant_id = ${tenantId}::uuid`;
      for (const table of [
        'book_version',
        'outbox_message',
        'processing_job',
        'idempotency_key',
        'book_file',
        'book',
      ]) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }
      await prisma.$executeRaw`DELETE FROM "user" WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM tenant WHERE id = ${tenantId}::uuid`;
    } catch (err) {
      console.warn('full-pipeline.e2e cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  it('stage 1: ingests the document (TypeScript worker)', async () => {
    const created = await harness.request('POST', '/api/v1/books', {
      token,
      body: { title: 'Pipeline Book', author: 'E2E', language: 'en' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status).toBe(201);
    bookId = (created.body as { data: { id: string } }).data.id;

    const pdf = await buildGoldenBookPdf();
    const session = await harness.request('POST', `/api/v1/books/${bookId}/upload-sessions`, {
      token,
      body: {
        file_name: 'pipeline.pdf',
        declared_mime_type: 'application/pdf',
        declared_size_bytes: pdf.byteLength,
        declared_content_hash: {
          algorithm: 'SHA256',
          value: createHash('sha256').update(pdf).digest('hex'),
        },
        source_kind: 'PDF',
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(session.status).toBe(201);
    const sessionData = (
      session.body as { data: { id: string; upload_targets: { url: string }[] } }
    ).data;

    const upload = await fetch(sessionData.upload_targets[0]!.url, {
      method: 'PUT',
      body: pdf,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(upload.ok).toBe(true);

    const completion = await harness.request(
      'POST',
      `/api/v1/books/${bookId}/upload-sessions/${sessionData.id}/completion`,
      {
        token,
        body: { observed_size_bytes: pdf.byteLength },
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    expect(completion.status).toBe(202);

    const state = await poll(`/api/v1/books/${bookId}/ingestion`, (s) =>
      ['COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'PARTIAL_OCR'].includes(s.status),
    );
    expect(state.status, `ingestion state: ${JSON.stringify(state)}`).toBe('COMPLETED');
  }, 120_000);

  it('stage 2: analyses the narrative (Python worker-ai over the ai queue)', async () => {
    const started = await harness.request('POST', `/api/v1/books/${bookId}/analysis`, {
      token,
      body: { scope: 'BOOK', mode: 'INCREMENTAL' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(started.status).toBe(202);

    const state = await poll(`/api/v1/books/${bookId}/analysis`, (s) =>
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s.status),
    );
    expect(state.status, `analysis state: ${JSON.stringify(state)}`).toBe('COMPLETED');

    // The cross-language hop actually persisted domain rows, not just a job status.
    const characters = await harness.request('GET', `/api/v1/books/${bookId}/characters`, {
      token,
    });
    expect(characters.status).toBe(200);
    const found = (characters.body as { data: unknown[] }).data;
    expect(found.length).toBeGreaterThan(0);

    const storyBible = await harness.request('GET', `/api/v1/books/${bookId}/story-bible`, {
      token,
    });
    expect(storyBible.status).toBe(200);
  }, 180_000);

  it('stage 3: casts every speaker (must precede the Director)', async () => {
    // Voice bindings are resolved *during* IR generation — the Director reads
    // the existing VoiceAssignment rows per chapter. Casting after the
    // Director would leave every chunk unbound and TTS would refuse the book
    // with CASTING_INCOMPLETE, so the ordering here is a real constraint of
    // the pipeline, not a convenience.
    const profile = await harness.request('POST', '/api/v1/voice-profiles', {
      token,
      body: { name: 'E2E Pipeline Voice', scope: 'TENANT' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(profile.status).toBe(201);
    voiceProfileId = (profile.body as { data: { id: string } }).data.id;

    const version = await harness.request(
      `POST`,
      `/api/v1/voice-profiles/${voiceProfileId}/versions`,
      {
        token,
        body: {
          tts_provider_id: 'mock-tts',
          tts_model_id: 'mock-tone',
          tts_model_version_id: ttsModelVersionId,
          language: 'en',
          reference_audio_consent: { attested: true, subject: 'SYNTHETIC' },
        },
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    expect(version.status).toBe(201);
    const versionData = (version.body as { data: { id: string; version: number } }).data;

    // A voice cannot be approved sight-unheard: approval requires at least
    // one READY preview, which is itself a real `generate_voice_preview` job
    // rendered by worker-gpu. This is a deliberate product gate, so the test
    // has to satisfy it the same way a user would.
    const preview = await harness.request(
      'POST',
      `/api/v1/voice-profiles/${voiceProfileId}/versions/${versionData.version}/previews`,
      {
        token,
        body: {
          // `book_id` is optional in the schema but mandatory in practice —
          // every ProcessingJob except `cleanup_artifacts` is book-scoped by a
          // DB CHECK constraint, and omitting it yields a 500 (see F-17).
          book_id: bookId,
          samples: [{ text_excerpt: 'The lighthouse keeper counted the ships.', emotion: 'NEUTRAL' }],
        },
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    expectStatus(preview, 202, 'voice preview request');

    await pollUntil(
      `/api/v1/voice-profiles/${voiceProfileId}/versions/${versionData.version}/previews`,
      (body) => {
        const rows = (body as { data: { status: string }[] }).data;
        return rows.length > 0 && rows.every((p) => ['READY', 'FAILED'].includes(p.status));
      },
      'voice preview',
    );

    // A DRAFT version cannot be cast — approval is the gate.
    const approved = await harness.request(
      'POST',
      `/api/v1/voice-profiles/${voiceProfileId}/versions/${versionData.version}/approval`,
      {
        token,
        body: { approved: true, note: 'e2e' },
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    expect(approved.status, `approval failed: ${JSON.stringify(approved.body)}`).toBe(200);

    // Cast every castable speaker: the real characters analysis discovered,
    // plus the NARRATOR sentinel (the only sentinel that accepts a voice).
    const characters = await harness.request('GET', `/api/v1/books/${bookId}/characters`, {
      token,
    });
    const roster = (
      characters.body as {
        data: { id: string; is_sentinel?: boolean; sentinel_kind?: string | null }[];
      }
    ).data;
    const castable = roster.filter((c) => !c.is_sentinel || c.sentinel_kind === 'NARRATOR');
    expect(castable.length).toBeGreaterThan(0);

    for (const character of castable) {
      const assigned = await harness.request(
        'PUT',
        `/api/v1/books/${bookId}/characters/${character.id}/voice`,
        {
          token,
          body: { voice_profile_id: voiceProfileId },
          headers: { 'idempotency-key': randomUUID() },
        },
      );
      expect(
        assigned.status,
        `assigning ${character.id}: ${JSON.stringify(assigned.body)}`,
      ).toBe(200);
    }

    const casting = await harness.request('GET', `/api/v1/books/${bookId}/casting`, { token });
    expect(casting.status).toBe(200);
  }, 240_000);

  it('stage 4: generates the Audio Script IR (Director, same Python worker)', async () => {
    const started = await harness.request('POST', `/api/v1/books/${bookId}/director`, {
      token,
      body: { scope: 'BOOK' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(started.status).toBe(202);

    const state = await poll(`/api/v1/books/${bookId}/director`, (s) =>
      ['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED'].includes(s.status),
    );
    expect(
      ['COMPLETED', 'NEEDS_REVIEW'],
      `director state: ${JSON.stringify(state)}`,
    ).toContain(state.status);

    // The IR must exist, be validated, and cover the book.
    const script = await harness.request('GET', `/api/v1/books/${bookId}/audio-script`, { token });
    expect(script.status).toBe(200);
    // The IR's lifecycle field is `state` (DRAFT -> VALIDATED -> LOCKED);
    // `status` belongs to the job, not the script.
    const scriptData = (script.body as { data: { id: string; state: string } }).data;
    expect(scriptData.state).toBe('VALIDATED');

    const chunks = await harness.request('GET', `/api/v1/books/${bookId}/audio-script-chunks`, {
      token,
    });
    expect(chunks.status).toBe(200);
    const chunkRows = (
      chunks.body as {
        data: {
          state: string;
          content: { text: string };
          performance: { speaker_type: string; emotion: string; character_id: string | null };
        }[];
      }
    ).data;
    expect(chunkRows.length).toBeGreaterThan(0);
    for (const chunk of chunkRows) {
      // Every chunk carries a resolved speaker and an emotion from the closed
      // vocabulary — the Director never emits a blank or invents an identity.
      expect(['NARRATOR', 'CHARACTER', 'UNKNOWN', 'SYSTEM']).toContain(
        chunk.performance.speaker_type,
      );
      expect(chunk.performance.emotion).toBeTruthy();
      expect(chunk.content.text.length).toBeGreaterThan(0);
    }
    // The golden fixture is mostly narration with two speaking characters, so
    // a run that resolved nothing at all would be a silent regression.
    const narrated = chunkRows.filter((c) => c.performance.speaker_type === 'NARRATOR');
    expect(narrated.length).toBeGreaterThan(0);

    // Casting in stage 3 must have bound every chunk — an unbound chunk is
    // what TTS rejects the whole book for.
    const unbound = await prisma.audioScriptChunk.count({
      where: { bookId, isCurrent: true, voiceProfileVersionId: null },
    });
    expect(unbound, 'every chunk must carry a voice binding after casting').toBe(0);
  }, 180_000);

  it('stage 5: synthesizes audio (Python worker-gpu over the gpu queue)', async () => {
    const started = await harness.request('POST', `/api/v1/books/${bookId}/tts`, {
      token,
      body: { scope: 'BOOK' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(started.status, `starting tts: ${JSON.stringify(started.body)}`).toBe(202);

    // `tts_state.status` echoes the Book's status, so completion is read from
    // the per-chunk counts: every chunk validated and none failed.
    // Completion has to be measured against how many chunks are EXPECTED, not
    // against "nothing is in flight". `getTtsState` derives its counts by
    // grouping existing AudioChunk rows, so a chunk whose TTS job is still
    // queued has no row at all and is counted neither as pending nor as
    // generating. "pending == 0 && generating == 0" is therefore true before
    // any work starts, and true again after merely the first chunk lands —
    // which made this poll exit on a half-finished pipeline and produced a
    // different partial result on every run.
    const expectedChunks = await prisma.audioScriptChunk.count({
      where: { bookId, isCurrent: true },
    });
    expect(expectedChunks).toBeGreaterThan(0);

    const state = await poll(`/api/v1/books/${bookId}/tts`, (s) => {
      const c = s.counts as Record<string, number>;
      const settled =
        (c.chunks_validated ?? 0) +
        (c.chunks_generated ?? 0) +
        (c.chunks_failed ?? 0) +
        (c.chunks_invalid ?? 0);
      return settled >= expectedChunks;
    });
    const counts = state.counts as Record<string, number>;
    // Any mismatch here is a worker-side outcome, so carry the worker's own
    // log into the failure — a bare `expect` leaves the explanation sitting
    // unread in the harness buffer.
    const ttsContext = () =>
      `tts state: ${JSON.stringify(state)}\n--- worker-gpu (last 30) ---\n` +
      harness.logs('worker-gpu').split('\n').slice(-30).join('\n');
    expect(counts.chunks_failed, ttsContext()).toBe(0);
    expect(counts.chunks_invalid, ttsContext()).toBe(0);
    // Every expected chunk must have reached VALIDATED — a partial count here
    // means the pipeline stalled, and assembly would refuse the book anyway.
    expect(counts.chunks_validated, ttsContext()).toBe(expectedChunks);

    // Real bytes exist in object storage for each chunk, and the
    // bytes-exist invariant holds: nothing is VALIDATED without a verified upload.
    const audioChunks = await prisma.audioChunk.findMany({ where: { bookId, isCurrent: true } });
    expect(audioChunks.length).toBeGreaterThan(0);
    for (const chunk of audioChunks) {
      expect(chunk.storageKey).toBeTruthy();
      expect(chunk.objectVerifiedAt, `${chunk.id} marked ready without a verified object`).not.toBeNull();
      expect(Number(chunk.durationMs)).toBeGreaterThan(0);
    }
  }, 300_000);

  it('stage 6: assembles and packages the audiobook (TypeScript worker-cpu + ffmpeg)', async () => {
    const started = await harness.request('POST', `/api/v1/books/${bookId}/assembly`, {
      token,
      body: { scope: 'AUDIOBOOK', delivery_formats: ['M4B'] },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(started.status, `starting assembly: ${JSON.stringify(started.body)}`).toBe(202);

    const state = await poll(`/api/v1/books/${bookId}/assembly`, (s) => {
      const assembled = s.chapters_assembled as number;
      const total = s.chapters_total as number;
      return (
        ['COMPLETED', 'READY', 'FAILED'].includes(s.status) || (total > 0 && assembled >= total)
      );
    });
    expect(state.status, `assembly state: ${JSON.stringify(state)}`).not.toBe('FAILED');
    expect(state.chapters_assembled).toBe(state.chapters_total);

    // Chapter masters exist as real, measured audio.
    const chapterAudio = await prisma.chapterAudio.findMany({ where: { bookId, isCurrent: true } });
    expect(chapterAudio.length).toBeGreaterThan(0);
    for (const master of chapterAudio) {
      expect(master.status).toBe('ASSEMBLED');
      expect(Number(master.durationMs)).toBeGreaterThan(0);
    }

    // The audiobook itself, readable over HTTP.
    //
    // Two different resources, two different status fields, and this test used
    // to conflate them: `/books/:id/audiobook` returns an `audiobook_project`
    // whose lifecycle field is `generation_status`
    // (NOT_STARTED|BLOCKED|ASSEMBLING|COMPLETED|FAILED|STALE, api-specification.md
    // §20.10) with duration under `totals` — it has no top-level `status` and no
    // top-level `duration_ms`. Polling for `status === 'READY'` therefore read
    // `undefined` forever and could only ever time out, no matter how healthy
    // the pipeline was. READY belongs to the `audiobook` entity, which is a
    // separate resource reached through the project's `current` link (F-25).
    const project = await poll(`/api/v1/books/${bookId}/audiobook`, (s) =>
      ['COMPLETED', 'FAILED'].includes(s.generation_status ?? ''),
    );
    expect(
      project.generation_status,
      `audiobook project: ${JSON.stringify(project)}`,
    ).toBe('COMPLETED');
    expect(project.current_audiobook_id).toBeTruthy();
    expect(Number(project.totals?.duration_ms)).toBeGreaterThan(0);

    const audiobookResponse = await harness.request(
      'GET',
      `/api/v1/books/${bookId}/audiobooks/${String(project.current_audiobook_id)}`,
      { token },
    );
    expect(audiobookResponse.status).toBe(200);
    const audiobook = (audiobookResponse.body as { data: StageState }).data;
    expect(audiobook.status, `audiobook: ${JSON.stringify(audiobook)}`).toBe('READY');
    expect(Number(audiobook.duration_ms)).toBeGreaterThan(0);
  }, 300_000);

  it('records an unbroken lineage across both runtimes', async () => {
    const audioScript = await prisma.audioScript.findFirst({
      where: { bookId, isCurrent: true },
    });
    expect(audioScript).not.toBeNull();

    // The IR points back at the exact BookVersion the TypeScript worker
    // produced, and at the Story Bible the Python worker produced — the
    // lineage crosses the language boundary without a break.
    const bookVersion = await prisma.bookVersion.findFirst({ where: { bookId, isCurrent: true } });
    expect(audioScript!.bookVersionId).toBe(bookVersion!.id);
    expect(audioScript!.storyBibleVersionId).toBeTruthy();
    expect(audioScript!.directorModelVersionId).toBeTruthy();
    expect(audioScript!.sourceContentHash).toBe(bookVersion!.contentHash);

    // Coverage is a hard invariant, not a report: the IR must account for the
    // whole book, with no gaps or overlaps.
    expect(audioScript!.coverageVerified).toBe(true);
    expect(audioScript!.coverageGapCount).toBe(0);
    expect(audioScript!.coverageOverlapCount).toBe(0);

    // Every job in the chain went through Redis (queuedAt is the marker the
    // orphaned-dispatch sweeper relies on).
    const jobs = await prisma.processingJob.findMany({ where: { bookId } });
    for (const type of [
      'parse_book',
      'analyze_scene',
      'generate_director_ir',
      'generate_tts_chunk',
      'assemble_chapter',
      'assemble_audiobook',
    ] as const) {
      const ofType = jobs.filter((j) => j.type === type);
      expect(ofType.length, `expected at least one ${type} job`).toBeGreaterThan(0);
      // At least one must have been dispatched. Not all of them: `startTts`
      // also creates a per-book coordinator ProcessingJob of the same type
      // that is deliberately never enqueued (it exists to own the request's
      // idempotency and correlation, not to be worked), so asserting on an
      // arbitrary row of this type would be asserting on the coordinator.
      expect(
        ofType.some((j) => j.queuedAt !== null),
        `no ${type} job was ever marked queued`,
      ).toBe(true);
    }

    // §135: from the finished audiobook, every hop back to the source document
    // is resolvable — the traceability the spec calls mandatory.
    const audiobook = await prisma.audiobook.findFirst({ where: { bookId, isCurrent: true } });
    expect(audiobook).not.toBeNull();
    expect(audiobook!.bookVersionId).toBe(bookVersion!.id);
    expect(audiobook!.chapterManifestHash).toBeTruthy();
    expect(audiobook!.audioToolModelVersionId).toBeTruthy();

    const anyChunk = await prisma.audioChunk.findFirst({ where: { bookId, isCurrent: true } });
    expect(anyChunk).not.toBeNull();
    // audio -> the voice it was rendered with -> the TTS model that rendered it
    expect(anyChunk!.voiceProfileVersionId).toBeTruthy();
    expect(anyChunk!.ttsModelVersionId).toBeTruthy();
    // audio -> the IR chunk -> the script -> the book version -> the source file
    const sourceChunk = await prisma.audioScriptChunk.findUnique({
      where: { id: anyChunk!.audioScriptChunkId },
    });
    expect(sourceChunk).not.toBeNull();
    expect(sourceChunk!.audioScriptId).toBe(audioScript!.id);
  });

  interface StageState {
    status: string;
    /** `audiobook_project` uses this instead of `status` (api-specification.md §20.10). */
    generation_status?: string;
    current_audiobook_id?: string;
    duration_ms?: number | string;
    totals?: { duration_ms?: number | string };
    [key: string]: unknown;
  }

  /**
   * Asserts a response status and, on mismatch, attaches the tail of the
   * relevant service log. A 500 from a child process is otherwise a dead end:
   * the client sees only the redacted envelope, and the stack that explains it
   * is sitting in a log nothing is reading.
   */
  function expectStatus(
    response: { status: number; body: unknown },
    expected: number,
    label: string,
    service: 'api' | 'worker-ai' | 'worker-gpu' = 'api',
  ): void {
    if (response.status === expected) return;
    const tail = harness.logs(service).split('\n').slice(-20).join('\n');
    throw new Error(
      `${label}: expected ${expected}, got ${response.status}\n` +
        `body: ${JSON.stringify(response.body)}\n` +
        `--- ${service} (last 20 lines) ---\n${tail}`,
    );
  }

  /** Polls a collection endpoint whose payload is a list rather than a state object. */
  async function pollUntil(
    path: string,
    done: (body: unknown) => boolean,
    label: string,
    // Must stay strictly below the enclosing `it` timeout, or vitest kills the
    // test first and this function never gets to attach its diagnostic.
    timeoutMs = 90_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const response = await harness.request('GET', path, { token });
      if (response.status === 200) {
        last = response.body;
        if (done(last)) return;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    const workerLog = harness.logs('worker-gpu').split('\n').slice(-25).join('\n');
    throw new Error(
      `${label} did not settle in ${timeoutMs}ms; last: ${JSON.stringify(last)}\n` +
        `--- worker-gpu (last 25 lines) ---\n${workerLog}`,
    );
  }

  async function poll(
    path: string,
    done: (state: StageState) => boolean,
    timeoutMs = 60_000,
  ): Promise<StageState> {
    const deadline = Date.now() + timeoutMs;
    let last: StageState = { status: 'UNKNOWN' };
    while (Date.now() < deadline) {
      const response = await harness.request('GET', path, { token });
      if (response.status === 200) {
        last = (response.body as { data: StageState }).data;
        if (done(last)) return last;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    // A stage that never settles has almost always failed inside a worker
    // process; without its log the test can only report "timed out".
    const workerLog = harness.logs('worker-ai').split('\n').slice(-25).join('\n');
    throw new Error(
      `${path} did not settle in ${timeoutMs}ms; last: ${JSON.stringify(last)}\n` +
        `--- worker-ai (last 25 lines) ---\n${workerLog}`,
    );
  }
});
