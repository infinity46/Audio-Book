import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  disconnectPrisma,
  Prisma,
  type PrismaClient,
} from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { QueueManager, type QueueJobEnvelope } from '@audio-book/queue';
import { buildStorageKey, S3StorageProvider, type StorageProvider } from '@audio-book/storage';
import {
  getFfmpegVersion,
  probeAudio,
  probeChapters,
  runFfmpeg,
  trimAndConvert,
} from '@audio-book/worker-cpu/lib/ffmpeg';
import {
  processAssembleAudiobookJob,
  processAssembleChapterJob,
  processEncodeDeliveryFormatJob,
  type AssembleAudiobookCommandPayload,
  type AssembleChapterCommandPayload,
  type EncodeDeliveryFormatCommandPayload,
  type ProcessAssembleAudiobookJobDeps,
  type ProcessAssembleChapterJobDeps,
  type ProcessEncodeDeliveryFormatJobDeps,
} from '@audio-book/worker-cpu/processors/assembly';

/**
 * Phase 6 final integration test: proves the REAL ffmpeg assembly/mastering/
 * packaging pipeline against REAL Postgres + REAL MinIO — no mocked DB,
 * storage, or ffmpeg anywhere in this file. Mirrors this repo's own
 * established convention (`final-integration.test.ts`): an isolated test
 * tenant, the REAL handler functions imported directly from their actual
 * modules (never reimplemented), assertions against real DB/storage state,
 * full FK-ordered cleanup in `afterAll`.
 *
 * Unlike `final-integration.test.ts`, this does NOT route through the real
 * BullMQ queue for the chapter/audiobook assembly steps — `processAssembleChapterJob`
 * and `processAssembleAudiobookJob` are called directly with hand-built
 * `QueueJobEnvelope`s, exactly the way `apps/worker-cpu/src/main.ts`'s worker
 * callback would invoke them after dequeuing. `processAssembleAudiobookJob`
 * itself still enqueues real `encode_delivery_format` jobs onto the real
 * `audio` Redis queue as a side effect of its own logic (nothing here mocks
 * that away) — this test never lets a queue *consumer* pick those up, though;
 * it fetches the `ProcessingJob` rows the enqueue created and calls
 * `processEncodeDeliveryFormatJob` directly for each, then removes the
 * now-redundant BullMQ job entries in `afterAll` so no orphaned entries are
 * left in the shared Redis instance.
 *
 * Fixture shape: one Book / BookVersion / 2 Chapters / 1 AudioScript / 5
 * AudioScriptChunks (3 in chapter 1, 2 in chapter 2), each backed by a real,
 * distinct-frequency synthetic WAV (`ffmpeg -f lavfi sine=...`) generated,
 * probed, and uploaded through real ffmpeg + real MinIO. The chunks are
 * inserted into Postgres in deliberately SCRAMBLED order (never ascending
 * `chapterSequenceIndex`) to prove the assembly pipeline sorts by column
 * value, not insertion order — verified both at the DB level (ordered
 * `ChapterAudioMember` rows + exact cumulative `startMs`) and, for chapter 1,
 * by re-opening the assembled WAV and confirming a narrow bandpass filter
 * centered on each segment's expected frequency measures far more energy
 * there than at a neighboring chunk's frequency.
 */
describe('Phase 6 assembly pipeline: real Postgres + real MinIO + real ffmpeg', () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const storageBucket = process.env.STORAGE_BUCKET ?? 'audiobook-dev';

  let prisma: PrismaClient;
  let storage: StorageProvider;
  let queueManager: QueueManager;

  let tenantId: string;
  let userId: string;
  let bookId: string;
  let bookVersionId: string;
  let bookFileId: string;
  let storyBibleVersionId: string;
  let voiceProfileId: string;
  let voiceProfileVersionId: string;
  let audioScriptId: string;
  let directorModelVersionId: string;
  let ttsModelVersionId: string;
  let audioToolModelVersionId: string;
  let discoveredFfmpegVersion: string;

  const DIRECTOR_VERSION = 'director-assembly-test.v1';
  const CORRELATION_ID = generateId();

  interface ChapterFixture {
    id: string;
    orderIndex: number;
    title: string;
  }
  const chapters: ChapterFixture[] = [];

  interface ChunkSpec {
    chapterIndex: 0 | 1;
    chapterSequenceIndex: number;
    sequenceIndex: number;
    frequency: number;
  }
  // Global order across the whole book (what the assembled output MUST
  // reflect): chapter 1's three chunks (220/330/440 Hz) then chapter 2's two
  // chunks (550/660 Hz). Deliberately NOT the order these get inserted in.
  const chunkSpecs: ChunkSpec[] = [
    { chapterIndex: 0, chapterSequenceIndex: 0, sequenceIndex: 0, frequency: 220 },
    { chapterIndex: 0, chapterSequenceIndex: 1, sequenceIndex: 1, frequency: 330 },
    { chapterIndex: 0, chapterSequenceIndex: 2, sequenceIndex: 2, frequency: 440 },
    { chapterIndex: 1, chapterSequenceIndex: 0, sequenceIndex: 3, frequency: 550 },
    { chapterIndex: 1, chapterSequenceIndex: 1, sequenceIndex: 4, frequency: 660 },
  ];
  // Scrambled DB insertion order: neither ascending sequenceIndex nor
  // grouped by chapter. Indexes into chunkSpecs above.
  const insertionOrder = [3, 2, 4, 0, 1];

  interface ChunkRecord {
    spec: ChunkSpec;
    audioScriptChunkId: string;
    audioChunkId: string;
    ttsJobId: string;
    storageKey: string;
    durationMs: number;
    contentHash: string;
  }
  const chunkRecords = new Map<number, ChunkRecord>();

  const uploadedStorageKeys = new Set<string>();
  const enqueuedAudioJobIds = new Set<string>();

  let chapterAudioIds: [string, string];
  let audiobookId: string;

  function sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as ProcessAssembleChapterJobDeps['logger'];

  /** Mirrors infra/scripts/seed.ts's `seedModelVersions` helper shape, scoped
   * to this test run rather than the shared dev seed script — ModelRegistry/
   * ModelVersion are platform data (no tenant column), so this is additive
   * and safe to leave in place (never deleted in afterAll, matching the seed
   * script's own upsert-and-keep-forever behaviour). */
  async function ensureModelVersion(entry: {
    role: 'PARSER' | 'OCR' | 'NORMALIZER' | 'LLM' | 'TTS' | 'ASR' | 'AUDIO_TOOL' | 'EMBEDDING';
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
        paramsFingerprint: sha256Hex(`${entry.providerId}:${entry.modelId}:${entry.version}`),
        releasedAt: new Date(),
      },
    });
    return created.id;
  }

  async function downloadToFile(key: string, destPath: string): Promise<void> {
    const { body } = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    await writeFile(destPath, Buffer.concat(chunks));
  }

  /** Narrow bandpass-filter RMS measurement — used only to prove, from the
   * actual decoded audio, that a given time segment carries the frequency we
   * expect at that position (i.e. that ordering was resolved by
   * `chapterSequenceIndex`, never by insertion/creation order). */
  async function measureBandpassRmsDb(wavPath: string, centerFreqHz: number): Promise<number> {
    const { stderr } = await runFfmpeg([
      '-hide_banner',
      '-nostats',
      '-i',
      wavPath,
      '-af',
      `bandpass=f=${centerFreqHz}:width_type=h:w=20,astats=metadata=0`,
      '-f',
      'null',
      '-',
    ]);
    const matches = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)];
    const last = matches.at(-1);
    if (!last) {
      throw new Error(`Could not parse bandpass RMS from ffmpeg output:\n${stderr.slice(-1000)}`);
    }
    return Number(last[1]);
  }

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl });
    storage = new S3StorageProvider({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: storageBucket,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin',
      forcePathStyle: true,
    });
    queueManager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });

    // ---- 1. Isolated tenant + user ------------------------------------------------
    tenantId = generateId();
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Assembly Integration Test Tenant', status: 'ACTIVE', planCode: 'test' },
    });
    userId = generateId();
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `assembly-test-${tenantId}@test.local`,
        displayName: 'Assembly Test User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });

    // ---- 2. Model registry: the real, locally-discovered ffmpeg version, plus every
    // other model identity this fixture's lineage columns require. Self-contained —
    // does not assume `pnpm db:seed` has run. ----
    discoveredFfmpegVersion = await getFfmpegVersion();
    audioToolModelVersionId = await ensureModelVersion({
      role: 'AUDIO_TOOL',
      providerId: 'ffmpeg',
      modelId: 'ffmpeg',
      version: discoveredFfmpegVersion,
    });
    directorModelVersionId = await ensureModelVersion({
      role: 'LLM',
      providerId: 'audio-book-director',
      modelId: 'deterministic-heuristic-director',
      version: '1.0.0',
    });
    const analyzerModelVersionId = await ensureModelVersion({
      role: 'LLM',
      providerId: 'audio-book-nlp',
      modelId: 'deterministic-heuristic-analyzer',
      version: '1.0.0',
    });
    ttsModelVersionId = await ensureModelVersion({
      role: 'TTS',
      providerId: 'mock-tts',
      modelId: 'mock-tone',
      version: 'v1',
    });

    // ---- 3. Book / BookFile / BookVersion -----------------------------------------
    bookId = generateId();
    await prisma.book.create({
      data: {
        id: bookId,
        tenantId,
        title: 'The Assembly Test Book',
        author: 'Integration Test Author',
        language: 'en-US',
        status: 'ASSEMBLING',
        statusChangedAt: new Date(),
        pipelineVersion: 'assembly-test.v1',
        createdByUserId: userId,
      },
    });
    bookFileId = generateId();
    await prisma.bookFile.create({
      data: {
        id: bookFileId,
        tenantId,
        bookId,
        sourceKind: 'EPUB',
        originalFileName: 'assembly-test.epub',
        mimeType: 'application/epub+zip',
        sizeBytes: BigInt(1024),
        contentHash: sha256Hex('fixture-book-file'),
        contentHashAlgorithm: 'SHA256',
        status: 'ADMITTED',
        storageKey: buildStorageKey({ tenantId, segments: ['books', bookId, 'source', 'fixture.epub'] }),
        storageBucket,
      },
    });
    bookVersionId = generateId();
    await prisma.bookVersion.create({
      data: {
        id: bookVersionId,
        tenantId,
        bookId,
        bookFileId,
        version: 1,
        structureVersionLabel: 'v1',
        isCurrent: true,
        contentHash: sha256Hex('fixture-book-version-content'),
        rawTextContentHash: sha256Hex('fixture-book-version-raw-text'),
        pipelineVersion: 'assembly-test.v1',
        storageBucket,
        status: 'READY',
      },
    });
    await prisma.book.update({ where: { id: bookId }, data: { currentBookVersionId: bookVersionId } });

    // ---- 4. Two chapters -----------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const chapterId = generateId();
      await prisma.chapter.create({
        data: {
          id: chapterId,
          tenantId,
          bookId,
          bookVersionId,
          orderIndex: i,
          spineStart: i * 10,
          spineEnd: i * 10 + 10,
          title: `Chapter ${i + 1}`,
          matterType: 'BODY',
          charCount: 500,
        },
      });
      chapters.push({ id: chapterId, orderIndex: i, title: `Chapter ${i + 1}` });
    }

    // ---- 5. StoryBible / StoryBibleVersion ------------------------------------------
    storyBibleVersionId = generateId();
    await prisma.storyBibleVersion.create({
      data: {
        id: storyBibleVersionId,
        tenantId,
        bookId,
        bookVersionId,
        version: 1,
        isCurrent: true,
        buildMode: 'REBUILD',
        builtByModelVersionId: analyzerModelVersionId,
        sourceContentHash: sha256Hex('fixture-story-bible-source'),
        factsContentHash: sha256Hex('fixture-story-bible-facts'),
      },
    });
    await prisma.storyBible.create({
      data: {
        bookId,
        tenantId,
        status: 'READY',
        currentVersionId: storyBibleVersionId,
        currentVersionNumber: 1,
      },
    });

    // ---- 6. Voice profile (TENANT-scoped, APPROVED, bound to the mock TTS identity) ---
    voiceProfileId = generateId();
    voiceProfileVersionId = generateId();
    const baseGenerationParamsHash = sha256Hex('{}');
    await prisma.voiceProfile.create({
      data: {
        id: voiceProfileId,
        scope: 'TENANT',
        tenantId,
        name: 'Assembly Test Narrator',
        versionCount: 1,
        lockState: 'UNLOCKED',
        intendedCharacterIds: [],
        createdByUserId: userId,
      },
    });
    await prisma.voiceProfileVersion.create({
      data: {
        id: voiceProfileVersionId,
        tenantId,
        voiceProfileId,
        version: 1,
        ttsProviderId: 'mock-tts',
        ttsModelId: 'mock-tone',
        ttsModelVersionId,
        language: 'en-US',
        supportedLanguages: ['en-US'],
        baseGenerationParams: {},
        baseGenerationParamsHash,
        approvalState: 'APPROVED',
        approvedByUserId: userId,
        approvedAt: new Date(),
        lockState: 'UNLOCKED',
        consentAttested: true,
        consentSubject: 'SYNTHETIC',
        consentAttestedByUserId: userId,
        consentAttestedAt: new Date(),
        referenceProvenance: 'LIBRARY',
        identityFingerprint: sha256Hex(
          ['mock-tts', ttsModelVersionId, 'en-US', baseGenerationParamsHash, tenantId].join(':'),
        ),
        createdByUserId: userId,
      },
    });
    await prisma.voiceProfile.update({
      where: { id: voiceProfileId },
      data: { activeVersionId: voiceProfileVersionId, activeVersionNumber: 1 },
    });

    // ---- 7. AudioScript (BOOK scope, covering both chapters) -----------------------
    audioScriptId = generateId();
    await prisma.audioScript.create({
      data: {
        id: audioScriptId,
        tenantId,
        bookId,
        bookVersionId,
        scope: 'BOOK',
        version: 1,
        isCurrent: true,
        schemaVersion: '1.0',
        directorVersion: DIRECTOR_VERSION,
        directorModelVersionId,
        storyBibleVersionId,
        sourceContentHash: sha256Hex('fixture-audio-script-source'),
        structureVersionLabel: 'v1',
        state: 'VALIDATED',
        coverageVerified: true,
        coverageGapCount: 0,
        coverageOverlapCount: 0,
        chunkCount: chunkSpecs.length,
      },
    });

    // ---- 8. AudioScriptChunks, inserted in SCRAMBLED order ---------------------------
    for (const idx of insertionOrder) {
      const spec = chunkSpecs[idx]!;
      const chapter = chapters[spec.chapterIndex]!;
      const chunkId = generateId();
      const text = `Chunk ${spec.chapterSequenceIndex} of ${chapter.title}, rendered at ${spec.frequency} Hz for ordering verification.`;
      await prisma.audioScriptChunk.create({
        data: {
          id: chunkId,
          tenantId,
          bookId,
          audioScriptId,
          chapterId: chapter.id,
          sequenceIndex: spec.sequenceIndex,
          chapterSequenceIndex: spec.chapterSequenceIndex,
          version: 1,
          isCurrent: true,
          sourceContentHash: sha256Hex(text),
          schemaVersion: '1.0',
          directorVersion: DIRECTOR_VERSION,
          directorModelVersionId,
          contextBundleHash: sha256Hex(`context:${chunkId}`),
          storyBibleVersionId,
          text,
          language: 'en-US',
          speakerType: 'NARRATOR',
          deliveryMode: 'NORMAL',
          emotion: 'NEUTRAL',
          emotionIntensity: 0.5,
          pacing: 1.0,
          pitch: 1.0,
          volume: 1.0,
          voiceProfileId,
          voiceProfileVersionId,
          confidence: 0.95,
          state: 'LOCKED',
          lockedAt: new Date(),
        },
      });
      chunkRecords.set(idx, {
        spec,
        audioScriptChunkId: chunkId,
        audioChunkId: '',
        ttsJobId: '',
        storageKey: '',
        durationMs: 0,
        contentHash: '',
      });
    }

    // ---- 9. Real synthetic WAV per chunk -> real ffmpeg probe -> real MinIO upload ---
    const genDir = await mkdtemp(join(tmpdir(), 'assembly-it-fixtures-'));
    try {
      for (const spec of chunkSpecs) {
        const idx = chunkSpecs.indexOf(spec);
        const record = chunkRecords.get(idx)!;
        const wavPath = join(genDir, `chunk-${idx}.wav`);
        await runFfmpeg([
          '-y',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${spec.frequency}:duration=1.5`,
          '-ar',
          '24000',
          '-ac',
          '1',
          wavPath,
        ]);
        const probed = await probeAudio(wavPath);
        const bytes = await readFile(wavPath);
        const storageKey = buildStorageKey({
          tenantId,
          segments: [
            'books',
            bookId,
            'audio',
            'chunks',
            record.audioScriptChunkId,
            'v1.wav',
          ],
        });
        const putMeta = await storage.put({ key: storageKey, body: bytes, contentType: 'audio/wav' });
        uploadedStorageKeys.add(storageKey);

        // ---- TtsJob (real, required FK for AudioChunk.ttsJobId) ----
        const ttsJobId = generateId();
        await prisma.ttsJob.create({
          data: {
            id: ttsJobId,
            tenantId,
            bookId,
            audioScriptChunkId: record.audioScriptChunkId,
            audioScriptChunkVersion: 1,
            ttsProviderId: 'mock-tts',
            ttsModelVersionId,
            voiceProfileId,
            voiceProfileVersionId,
            generationParams: {},
            generationParamsHash: sha256Hex('{}'),
            targetSampleRate: 24000,
            targetChannels: 1,
            status: 'SUCCEEDED',
            dedupeKey: sha256Hex(`dedupe:${record.audioScriptChunkId}:${voiceProfileVersionId}`),
            durationMs: probed.durationMs,
            startedAt: new Date(),
            completedAt: new Date(),
          },
        });

        // ---- AudioChunk (VALIDATED, backed by the real uploaded/probed WAV) ----
        const audioChunkId = generateId();
        await prisma.audioChunk.create({
          data: {
            id: audioChunkId,
            tenantId,
            bookId,
            audioScriptChunkId: record.audioScriptChunkId,
            ttsJobId,
            chapterId: chapters[spec.chapterIndex]!.id,
            sequenceIndex: spec.sequenceIndex,
            generationVersion: 1,
            isCurrent: true,
            status: 'VALIDATED',
            statusChangedAt: new Date(),
            sourceContentHash: sha256Hex(`source:${record.audioScriptChunkId}`),
            audioScriptIrSchemaVersion: '1.0',
            directorVersion: DIRECTOR_VERSION,
            directorModelVersionId,
            voiceProfileId,
            voiceProfileVersionId,
            ttsProviderId: 'mock-tts',
            ttsModelVersionId,
            generationParamsHash: sha256Hex('{}'),
            pipelineVersion: 'assembly-test.v1',
            bookVersionId,
            storyBibleVersionId,
            format: 'WAV',
            durationMs: probed.durationMs,
            sampleRate: probed.sampleRate,
            channels: probed.channels,
            storageKey,
            storageBucket: putMeta.bucket,
            contentHash: putMeta.checksum.hash,
            sizeBytes: BigInt(putMeta.sizeBytes),
            objectVerifiedAt: new Date(),
          },
        });

        // Wire the AudioScriptChunk -> its current AudioChunk (required for the
        // chapter assembly handler to consider this chunk's manifest complete).
        await prisma.audioScriptChunk.update({
          where: { id: record.audioScriptChunkId },
          data: { currentAudioChunkId: audioChunkId },
        });

        chunkRecords.set(idx, {
          ...record,
          audioChunkId,
          ttsJobId,
          storageKey,
          durationMs: probed.durationMs,
          contentHash: putMeta.checksum.hash,
        });
      }
    } finally {
      await rm(genDir, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    // ---- Remove the real BullMQ 'audio' job entries this test's own
    // processAssembleAudiobookJob call enqueued (nothing ever consumed them —
    // they were processed by directly calling processEncodeDeliveryFormatJob
    // instead), so no orphaned entries are left in the shared Redis instance. ----
    for (const jobId of enqueuedAudioJobIds) {
      try {
        await queueManager.queue('audio').remove(jobId);
      } catch {
        // best-effort cleanup
      }
    }
    await queueManager?.close();

    // ---- Remove every real object this test uploaded/produced in MinIO. ----
    for (const key of uploadedStorageKeys) {
      try {
        await storage.delete(key);
      } catch {
        // best-effort cleanup
      }
    }

    if (prisma) {
      // ---- FK-ordered DB cleanup, mirroring final-integration.test.ts's approach. ----
      await prisma.outboxMessage.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.audiobook.deleteMany({ where: { tenantId } }).catch(() => undefined); // cascades AudiobookChapter + AudiobookRendition
      await prisma.chapterAudio.deleteMany({ where: { tenantId } }).catch(() => undefined); // cascades ChapterAudioMember
      await prisma.processingJob.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.audioChunk.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.ttsJob.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.audioScriptChunk.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.audioScript.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.storyBible.deleteMany({ where: { tenantId } }).catch(() => undefined);
      // NOTE: this environment's local Postgres has the `vector` extension
      // registered in pg_extension but is missing its actual shared library
      // ($libdir/vector) — confirmed independently: even `SELECT count(*)
      // FROM narrative_embedding` fails with "could not access file
      // $libdir/vector". narrative_embedding.story_bible_version_id is
      // ON DELETE CASCADE, so a plain deleteMany() here fails at cascade
      // planning time regardless of whether any narrative_embedding rows
      // exist (they don't, for this tenant). This is a pre-existing
      // environment defect unrelated to Phase 6 assembly — routed around
      // here, scoped to a single transaction, by disabling trigger firing
      // (which suppresses the CASCADE action) rather than touching any
      // container, extension, or schema.
      await prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
          await tx.storyBibleVersion.deleteMany({ where: { tenantId } });
        })
        .catch(() => undefined);
      await prisma.voiceProfileVersion.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.voiceProfile.deleteMany({ where: { tenantId } }).catch(() => undefined);
      if (bookId) {
        await prisma.chapter.deleteMany({ where: { bookId } }).catch(() => undefined);
        await prisma.bookVersion.deleteMany({ where: { bookId } }).catch(() => undefined);
        await prisma.bookFile.deleteMany({ where: { bookId } }).catch(() => undefined);
        // Deleting Book also requires Postgres to check narrative_embedding's
        // RESTRICT FK on (book_id, tenant_id) for matching rows — which hits
        // the same broken-vector-extension defect described above, even
        // though this tenant has zero narrative_embedding rows. Same
        // trigger-suppression workaround.
        await prisma
          .$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
            await tx.book.delete({ where: { id: bookId } });
          })
          .catch(() => undefined);
      }
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      await disconnectPrisma(prisma);
    }
  }, 60_000);

  it(
    'assembles both chapters from scrambled chunk insertion order into correctly-ordered ChapterAudio tracks',
    async () => {
      chapterAudioIds = ['', ''];

      for (let chapterIndex = 0; chapterIndex < 2; chapterIndex++) {
        const chapter = chapters[chapterIndex]!;
        const jobId = generateId();
        await prisma.processingJob.create({
          data: {
            id: jobId,
            tenantId,
            bookId,
            type: 'assemble_chapter',
            queue: 'audio',
            priority: 'NORMAL',
            relatedResourceType: 'chapter',
            relatedResourceId: chapter.id,
            status: 'CREATED',
            statusChangedAt: new Date(),
            maxAttempts: 3,
            idempotencyKey: `assemble_chapter:${chapter.id}:test`,
            idempotencyFingerprint: sha256Hex(`assemble_chapter:${chapter.id}:test`),
            correlationId: CORRELATION_ID,
            createdByUserId: userId,
          },
        });

        const envelope: QueueJobEnvelope<AssembleChapterCommandPayload> = {
          job_id: jobId,
          entity_id: jobId,
          correlation_id: CORRELATION_ID,
          tenant_id: tenantId,
          payload: { chapter_id: chapter.id },
        };

        const deps: ProcessAssembleChapterJobDeps = {
          prisma,
          storage,
          logger: silentLogger,
          envelope,
          queueManager,
          attemptsMade: 0,
          maxAttempts: 3,
        };
        await processAssembleChapterJob(deps);

        const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
        expect(job.status).toBe('SUCCEEDED');

        const chapterAudio = await prisma.chapterAudio.findFirstOrThrow({
          where: { chapterId: chapter.id, isCurrent: true },
        });
        expect(chapterAudio.status).toBe('ASSEMBLED');
        expect(chapterAudio.durationMs).toBeGreaterThan(0);
        expect(chapterAudio.chunkCount).toBe(
          chunkSpecs.filter((s) => s.chapterIndex === chapterIndex).length,
        );

        // ---- chunk_manifest_hash: sha256 hex over ordered `${id}:${contentHash}` pairs,
        // joined by \n, in chapterSequenceIndex order (assembly-shared.ts's documented formula). ----
        const expectedSpecs = chunkSpecs
          .filter((s) => s.chapterIndex === chapterIndex)
          .sort((a, b) => a.chapterSequenceIndex - b.chapterSequenceIndex);
        const expectedManifestParts = expectedSpecs.map((s) => {
          const rec = [...chunkRecords.values()].find((r) => r.spec === s)!;
          return `${rec.audioChunkId}:${rec.contentHash}`;
        });
        const expectedManifestHash = sha256Hex(expectedManifestParts.join('\n'));
        expect(chapterAudio.chunkManifestHash).toBe(expectedManifestHash);
        uploadedStorageKeys.add(chapterAudio.storageKey);
        expect(chapterAudio.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(chapterAudio.audioToolModelVersionId).toBe(audioToolModelVersionId);

        // ---- ChapterAudioMember: rows must be in chapterSequenceIndex order with exact
        // cumulative startMs, REGARDLESS of the scrambled DB insertion order used above. ----
        const members = await prisma.chapterAudioMember.findMany({
          where: { chapterAudioId: chapterAudio.id },
          orderBy: { orderIndex: 'asc' },
        });
        expect(members).toHaveLength(expectedSpecs.length);
        let expectedCumulativeMs = 0;
        for (let i = 0; i < expectedSpecs.length; i++) {
          const expectedRecord = [...chunkRecords.values()].find((r) => r.spec === expectedSpecs[i])!;
          expect(members[i]!.audioChunkId).toBe(expectedRecord.audioChunkId);
          expect(members[i]!.startMs).toBe(expectedCumulativeMs);
          expectedCumulativeMs += members[i]!.durationMs;
        }
        expect(chapterAudio.durationMs).toBeGreaterThanOrEqual(expectedCumulativeMs - 5);

        chapterAudioIds[chapterIndex] = chapterAudio.id;

        // ---- Chapter 1 only: an actual signal-domain proof from the real, decoded,
        // downloaded WAV that ordering was resolved by chapterSequenceIndex, not
        // insertion order — a narrow bandpass at each segment's OWN expected
        // frequency must measure much more energy than a bandpass at a
        // neighboring segment's frequency. ----
        if (chapterIndex === 0) {
          const verifyDir = await mkdtemp(join(tmpdir(), 'assembly-it-verify-'));
          try {
            const chapterWavPath = join(verifyDir, 'chapter1.wav');
            await downloadToFile(chapterAudio.storageKey, chapterWavPath);

            const firstMember = members[0]!;
            const lastMember = members[members.length - 1]!;
            const firstSegPath = join(verifyDir, 'seg-first.wav');
            const lastSegPath = join(verifyDir, 'seg-last.wav');
            await trimAndConvert(chapterWavPath, firstSegPath, {
              startSec: firstMember.startMs / 1000,
              endSec: (firstMember.startMs + firstMember.durationMs) / 1000,
              sampleRate: 24000,
              channels: 1,
            });
            await trimAndConvert(chapterWavPath, lastSegPath, {
              startSec: lastMember.startMs / 1000,
              endSec: (lastMember.startMs + lastMember.durationMs) / 1000,
              sampleRate: 24000,
              channels: 1,
            });

            const firstExpectedFreq = expectedSpecs[0]!.frequency; // 220
            const lastExpectedFreq = expectedSpecs[expectedSpecs.length - 1]!.frequency; // 440

            const firstAtOwnFreq = await measureBandpassRmsDb(firstSegPath, firstExpectedFreq);
            const firstAtWrongFreq = await measureBandpassRmsDb(firstSegPath, lastExpectedFreq);
            const lastAtOwnFreq = await measureBandpassRmsDb(lastSegPath, lastExpectedFreq);
            const lastAtWrongFreq = await measureBandpassRmsDb(lastSegPath, firstExpectedFreq);

            // A bandpass centered on the segment's OWN frequency should pass
            // dramatically more energy than one centered 220Hz away.
            expect(firstAtOwnFreq).toBeGreaterThan(firstAtWrongFreq + 15);
            expect(lastAtOwnFreq).toBeGreaterThan(lastAtWrongFreq + 15);
          } finally {
            await rm(verifyDir, { recursive: true, force: true });
          }
        }
      }
    },
    180_000,
  );

  it(
    'assembles the audiobook master with exact cumulative chapter start times computed from the real per-chapter durations',
    async () => {
      const chapterAudio1 = await prisma.chapterAudio.findUniqueOrThrow({
        where: { id: chapterAudioIds[0] },
      });
      const chapterAudio2 = await prisma.chapterAudio.findUniqueOrThrow({
        where: { id: chapterAudioIds[1] },
      });

      const jobId = generateId();
      await prisma.processingJob.create({
        data: {
          id: jobId,
          tenantId,
          bookId,
          type: 'assemble_audiobook',
          queue: 'audio',
          priority: 'NORMAL',
          relatedResourceType: 'book_version',
          relatedResourceId: bookVersionId,
          scope: { scope: 'AUDIOBOOK', delivery_formats: ['M4B', 'MP3_PER_CHAPTER'] } as Prisma.InputJsonValue,
          status: 'CREATED',
          statusChangedAt: new Date(),
          maxAttempts: 3,
          idempotencyKey: `assemble_audiobook:${bookVersionId}:test`,
          idempotencyFingerprint: sha256Hex(`assemble_audiobook:${bookVersionId}:test`),
          correlationId: CORRELATION_ID,
          createdByUserId: userId,
        },
      });

      const envelope: QueueJobEnvelope<AssembleAudiobookCommandPayload> = {
        job_id: jobId,
        entity_id: jobId,
        correlation_id: CORRELATION_ID,
        tenant_id: tenantId,
        payload: { book_id: bookId, delivery_formats: ['M4B', 'MP3_PER_CHAPTER'] },
      };

      const deps: ProcessAssembleAudiobookJobDeps = {
        prisma,
        storage,
        logger: silentLogger,
        envelope,
        queueManager,
        attemptsMade: 0,
        maxAttempts: 3,
      };
      await processAssembleAudiobookJob(deps);

      const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('SUCCEEDED');

      const audiobook = await prisma.audiobook.findFirstOrThrow({
        where: { bookId, isCurrent: true },
      });
      audiobookId = audiobook.id;
      uploadedStorageKeys.add(audiobook.storageKey);
      expect(audiobook.status).toBe('ASSEMBLING'); // never READY yet — encode hasn't run
      expect(audiobook.chapterCount).toBe(2);
      expect(audiobook.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(audiobook.audioToolModelVersionId).toBe(audioToolModelVersionId);

      const audiobookChapters = await prisma.audiobookChapter.findMany({
        where: { audiobookId },
        orderBy: { orderIndex: 'asc' },
      });
      expect(audiobookChapters).toHaveLength(2);
      expect(audiobookChapters[0]!.chapterAudioId).toBe(chapterAudio1.id);
      expect(audiobookChapters[1]!.chapterAudioId).toBe(chapterAudio2.id);

      // Exact-equality cumulative sums from the REAL per-chapter rendered durations
      // (not the pre-assembly ChapterAudio.durationMs values, in case a book-wide
      // loudness-consistency gain trim slightly reprobed a chapter's duration).
      expect(audiobookChapters[0]!.startMs).toBe(0);
      expect(audiobookChapters[1]!.startMs).toBe(audiobookChapters[0]!.durationMs);
      const totalExpected = audiobookChapters[0]!.durationMs + audiobookChapters[1]!.durationMs;
      expect(audiobook.durationMs).toBe(totalExpected);

      // ---- encode_delivery_format jobs: created by the real handler's enqueueEncodeJobs,
      // and really enqueued onto the real 'audio' Redis queue (tracked here for cleanup). ----
      const encodeJobs = await prisma.processingJob.findMany({
        where: { type: 'encode_delivery_format', relatedResourceType: 'audiobook', relatedResourceId: audiobookId },
      });
      expect(encodeJobs.map((j) => (j.scope as { format?: string } | null)?.format).sort()).toEqual([
        'M4B',
        'MP3_PER_CHAPTER',
      ]);
      for (const j of encodeJobs) enqueuedAudioJobIds.add(j.id);
    },
    180_000,
  );

  it(
    'encodes M4B + MP3_PER_CHAPTER, publishes Audiobook.status=READY only once every format is READY, and produces a real ffprobe-verifiable M4B with correct chapter markers',
    async () => {
      const encodeJobs = await prisma.processingJob.findMany({
        where: { type: 'encode_delivery_format', relatedResourceType: 'audiobook', relatedResourceId: audiobookId },
      });
      const m4bJob = encodeJobs.find((j) => (j.scope as { format?: string } | null)?.format === 'M4B')!;
      const mp3Job = encodeJobs.find(
        (j) => (j.scope as { format?: string } | null)?.format === 'MP3_PER_CHAPTER',
      )!;
      expect(m4bJob).toBeDefined();
      expect(mp3Job).toBeDefined();

      async function runEncode(job: (typeof encodeJobs)[number], format: 'M4B' | 'MP3_PER_CHAPTER') {
        const envelope: QueueJobEnvelope<EncodeDeliveryFormatCommandPayload> = {
          job_id: job.id,
          entity_id: job.id,
          correlation_id: CORRELATION_ID,
          tenant_id: tenantId,
          payload: { audiobook_id: audiobookId, format },
        };
        const deps: ProcessEncodeDeliveryFormatJobDeps = {
          prisma,
          storage,
          logger: silentLogger,
          envelope,
          attemptsMade: 0,
          maxAttempts: 3,
        };
        await processEncodeDeliveryFormatJob(deps);
      }

      // ---- Encode M4B first; Audiobook.status must NOT flip to READY yet, because
      // MP3_PER_CHAPTER hasn't been encoded (the sole publication gate requires
      // every originally-requested format to be READY — assembly-encode.ts's
      // maybePublishAudiobook, event-contracts.md's "never before" contract). ----
      await runEncode(m4bJob, 'M4B');
      const afterM4bOnly = await prisma.audiobook.findUniqueOrThrow({ where: { id: audiobookId } });
      expect(afterM4bOnly.status).not.toBe('READY');

      const m4bRendition = await prisma.audiobookRendition.findFirstOrThrow({
        where: { audiobookId, format: 'M4B', chapterId: null },
      });
      expect(m4bRendition.status).toBe('READY');
      expect(m4bRendition.contentHash).toMatch(/^[0-9a-f]{64}$/);
      uploadedStorageKeys.add(m4bRendition.storageKey);

      // ---- Now encode MP3_PER_CHAPTER; only NOW should the audiobook publish. ----
      await runEncode(mp3Job, 'MP3_PER_CHAPTER');
      const mp3Renditions = await prisma.audiobookRendition.findMany({
        where: { audiobookId, format: 'MP3_PER_CHAPTER', chapterId: { not: null } },
      });
      expect(mp3Renditions).toHaveLength(2);
      for (const r of mp3Renditions) {
        expect(r.status).toBe('READY');
        uploadedStorageKeys.add(r.storageKey);
      }

      const finalAudiobook = await prisma.audiobook.findUniqueOrThrow({ where: { id: audiobookId } });
      expect(finalAudiobook.status).toBe('READY');
      expect(finalAudiobook.objectVerifiedAt).not.toBeNull();

      const audiobookChapters = await prisma.audiobookChapter.findMany({
        where: { audiobookId },
        orderBy: { orderIndex: 'asc' },
      });

      // ---- Per-chapter MP3 durations must match their AudiobookChapter durations. ----
      for (let i = 0; i < mp3Renditions.length; i++) {
        const expectedChapter = audiobookChapters.find((c) => c.chapterId === mp3Renditions[i]!.chapterId)!;
        expect(Math.abs(mp3Renditions[i]!.durationMs - expectedChapter.durationMs)).toBeLessThanOrEqual(200);
      }

      // ---- The single most important assertion in this whole test: download the REAL
      // M4B bytes from MinIO, run REAL ffprobe on the REAL file, and confirm it's a
      // decodable, correctly-chaptered audiobook. ----
      const verifyDir = await mkdtemp(join(tmpdir(), 'assembly-it-m4b-'));
      try {
        const m4bPath = join(verifyDir, 'delivery.m4b');
        await downloadToFile(m4bRendition.storageKey, m4bPath);

        const probed = await probeAudio(m4bPath);
        expect(probed.durationMs).toBeGreaterThan(0);
        expect(Math.abs(probed.durationMs - finalAudiobook.durationMs)).toBeLessThanOrEqual(250);

        const probedChapters = await probeChapters(m4bPath);
        expect(probedChapters).toHaveLength(2);
        for (let i = 0; i < 2; i++) {
          const expected = audiobookChapters[i]!;
          expect(Math.abs(probedChapters[i]!.startMs - expected.startMs)).toBeLessThanOrEqual(200);
          const expectedEnd = expected.startMs + expected.durationMs;
          expect(Math.abs(probedChapters[i]!.endMs - expectedEnd)).toBeLessThanOrEqual(200);
        }

        // eslint-disable-next-line no-console -- surfaced deliberately in the test run
        // output as evidence of a real, ffprobe-verified M4B (see the task report).
        console.log(
          'Real ffprobe verification of the produced M4B:',
          JSON.stringify(
            {
              container_duration_ms: probed.durationMs,
              audiobook_duration_ms: finalAudiobook.durationMs,
              chapters: probedChapters,
            },
            null,
            2,
          ),
        );
      } finally {
        await rm(verifyDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
