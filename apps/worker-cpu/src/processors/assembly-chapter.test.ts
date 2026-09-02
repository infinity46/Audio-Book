import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InMemoryStorageProvider } from '@audio-book/storage';

/**
 * Mocks `../lib/ffmpeg.js` at the module level — both assembly-chapter.ts
 * AND assembly-shared.ts's `resolveAudioToolModelVersionId` resolve to this
 * same mock (they import the same relative path), so `getFfmpegVersion`
 * only needs to be stubbed once here. Every function that produces an
 * output file writes a small real file at that path (mocked ffmpeg does no
 * real audio work, but `processAssembleChapterJob` still does a REAL
 * `node:fs.readFile` on the final master before uploading it, so the file
 * must actually exist on disk).
 */
const ffmpegMocks = vi.hoisted(() => ({
  getFfmpegVersion: vi.fn(async () => '6.1.1'),
  probeAudio: vi.fn(async () => ({ durationMs: 1000, sampleRate: 24000, channels: 1, formatName: 'wav' })),
  detectSilence: vi.fn(async () => []),
  trimAndConvert: vi.fn(async () => {}),
  applySinglePassLoudnorm: vi.fn(async () => {}),
  generateSilenceFile: vi.fn(async () => {}),
  writeConcatFileList: vi.fn(async () => {}),
  concatDemuxCopy: vi.fn(async () => {}),
  applyTwoPassLoudnorm: vi.fn(async () => ({
    input_i: '-25',
    input_tp: '-6',
    input_lra: '7',
    input_thresh: '-35',
    target_offset: '0',
  })),
  measureEbur128: vi.fn(async () => ({ integratedLufs: -20, truePeakDbtp: -3 })),
  measureClipping: vi.fn(async () => ({ clippedSamples: 0, peakDbfs: -5 })),
  measureOverallRmsDb: vi.fn(async () => -65),
}));

vi.mock('../lib/ffmpeg.js', () => ({
  getFfmpegVersion: ffmpegMocks.getFfmpegVersion,
  probeAudio: ffmpegMocks.probeAudio,
  detectSilence: ffmpegMocks.detectSilence,
  trimAndConvert: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.trimAndConvert();
  },
  applySinglePassLoudnorm: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.applySinglePassLoudnorm();
  },
  generateSilenceFile: async (output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.generateSilenceFile();
  },
  writeConcatFileList: ffmpegMocks.writeConcatFileList,
  concatDemuxCopy: async (_listPath: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.concatDemuxCopy();
  },
  applyTwoPassLoudnorm: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.applyTwoPassLoudnorm();
  },
  measureEbur128: ffmpegMocks.measureEbur128,
  measureClipping: ffmpegMocks.measureClipping,
  measureOverallRmsDb: ffmpegMocks.measureOverallRmsDb,
}));

const { processAssembleChapterJob } = await import('./assembly-chapter.js');

interface FakeRow {
  [key: string]: unknown;
}

function makeMockPrisma() {
  const processingJobs = new Map<string, FakeRow>();
  const chapters = new Map<string, FakeRow>();
  const books = new Map<string, FakeRow>();
  let audioScriptChunks: FakeRow[] = [];
  const chapterAudios: FakeRow[] = [];
  const chapterAudioMembers: FakeRow[] = [];
  const modelRegistries = new Map<string, FakeRow>();
  const modelVersions = new Map<string, FakeRow>();
  const outboxMessages: FakeRow[] = [];
  const jobUpdates: FakeRow[] = [];
  const createdProcessingJobs: FakeRow[] = [];

  function seedModelVersion(role: string, providerId: string, modelId: string, version: string) {
    const registryId = `registry-${role}-${providerId}-${modelId}`;
    modelRegistries.set(`${role}:${providerId}:${modelId}`, { id: registryId, role, providerId, modelId });
    const versionId = `version-${registryId}-${version}`;
    modelVersions.set(`${registryId}:${version}`, { id: versionId, modelRegistryId: registryId, version });
  }
  seedModelVersion('AUDIO_TOOL', 'ffmpeg', 'ffmpeg', '6.1.1');

  function isChapterReady(chapterId: string): boolean {
    return chapterAudios.some(
      (ca) => ca.chapterId === chapterId && ca.isCurrent === true && ca.status === 'ASSEMBLED',
    );
  }

  const tx = {
    processingJob: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(processingJobs.get(where.id) ?? null),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: FakeRow }) => {
        jobUpdates.push({ where, data });
        const current = processingJobs.get(where.id) ?? {};
        const merged = { ...current };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as FakeRow)) {
            merged[k] = ((current[k] as number) ?? 0) + ((v as FakeRow).increment as number);
          } else {
            merged[k] = v;
          }
        }
        processingJobs.set(where.id, merged);
        return Promise.resolve(merged);
      }),
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          [...processingJobs.values()].find(
            (j) =>
              j.bookId === where.bookId &&
              j.type === where.type &&
              (where.status as { in: string[] })?.in.includes(j.status as string),
          ) ?? null,
        ),
      ),
      create: vi.fn(({ data }: { data: FakeRow }) => {
        processingJobs.set(data.id as string, data);
        createdProcessingJobs.push(data);
        return Promise.resolve(data);
      }),
    },
    chapter: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(chapters.get(where.id) ?? null),
      ),
      count: vi.fn(({ where }: { where: FakeRow }) => {
        const inVersion = [...chapters.values()].filter((c) => c.bookVersionId === where.bookVersionId);
        if (where.chapterAudios) {
          return Promise.resolve(inVersion.filter((c) => !isChapterReady(c.id as string)).length);
        }
        return Promise.resolve(inVersion.length);
      }),
    },
    book: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(books.get(where.id) ?? null)),
    },
    audioScriptChunk: {
      findMany: vi.fn(({ where }: { where: FakeRow }) => {
        const matched = audioScriptChunks.filter(
          (c) => c.chapterId === where.chapterId && c.isCurrent === true,
        );
        matched.sort(
          (a, b) => (a.chapterSequenceIndex as number) - (b.chapterSequenceIndex as number),
        );
        return Promise.resolve(matched);
      }),
    },
    chapterAudio: {
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          chapterAudios.find(
            (ca) =>
              ca.chapterId === where.chapterId &&
              ca.chunkManifestHash === where.chunkManifestHash &&
              ca.isPreviewBuild === where.isPreviewBuild,
          ) ?? null,
        ),
      ),
      aggregate: vi.fn(({ where }: { where: FakeRow }) => {
        const versions = chapterAudios
          .filter((ca) => ca.chapterId === where.chapterId)
          .map((ca) => ca.version as number);
        return Promise.resolve({ _max: { version: versions.length ? Math.max(...versions) : null } });
      }),
      updateMany: vi.fn(({ where, data }: { where: FakeRow; data: FakeRow }) => {
        const matched = chapterAudios.filter(
          (ca) => ca.chapterId === where.chapterId && ca.isCurrent === where.isCurrent,
        );
        for (const ca of matched) Object.assign(ca, data);
        return Promise.resolve({ count: matched.length });
      }),
      create: vi.fn(({ data }: { data: FakeRow }) => {
        chapterAudios.push(data);
        return Promise.resolve(data);
      }),
    },
    chapterAudioMember: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        chapterAudioMembers.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    modelRegistry: {
      findUnique: vi.fn(
        ({
          where,
        }: {
          where: { role_providerId_modelId: { role: string; providerId: string; modelId: string } };
        }) => {
          const { role, providerId, modelId } = where.role_providerId_modelId;
          return Promise.resolve(modelRegistries.get(`${role}:${providerId}:${modelId}`) ?? null);
        },
      ),
    },
    modelVersion: {
      findFirst: vi.fn(({ where }: { where: { modelRegistryId: string; version: string } }) =>
        Promise.resolve(modelVersions.get(`${where.modelRegistryId}:${where.version}`) ?? null),
      ),
    },
    outboxMessage: {
      create: vi.fn(({ data }: { data: FakeRow }) => {
        outboxMessages.push(data);
        return Promise.resolve(data);
      }),
    },
  };

  const prisma = {
    ...tx,
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return {
    prisma,
    processingJobs,
    chapters,
    books,
    setAudioScriptChunks: (rows: FakeRow[]) => {
      audioScriptChunks = rows;
    },
    chapterAudios,
    chapterAudioMembers,
    outboxMessages,
    jobUpdates,
    createdProcessingJobs,
  };
}

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;

function makeEnvelope(chapterId: string, jobId = 'job-1') {
  return {
    job_id: 'msg-1',
    entity_id: jobId,
    correlation_id: 'corr-1',
    tenant_id: 'tenant-1',
    payload: { chapter_id: chapterId },
  };
}

function makeAudioChunk(id: string, overrides: FakeRow = {}): FakeRow {
  return {
    id,
    storageKey: `tenant-1/books/book-1/chunks/${id}.wav`,
    contentHash: `hash-${id}`,
    status: 'VALIDATED',
    sampleRate: 24000,
    channels: 1,
    ...overrides,
  };
}

function makeScriptChunk(
  id: string,
  chapterId: string,
  chapterSequenceIndex: number,
  audioChunk: FakeRow | null,
  overrides: FakeRow = {},
): FakeRow {
  return {
    id,
    chapterId,
    isCurrent: true,
    sequenceIndex: chapterSequenceIndex,
    chapterSequenceIndex,
    directorVersion: 'director.v1',
    characterId: null,
    voiceProfileVersionId: 'vpv-1',
    pauses: null,
    currentAudioChunk: audioChunk,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ffmpegMocks.getFfmpegVersion.mockResolvedValue('6.1.1');
  ffmpegMocks.probeAudio.mockResolvedValue({ durationMs: 1000, sampleRate: 24000, channels: 1, formatName: 'wav' });
  ffmpegMocks.detectSilence.mockResolvedValue([]);
  ffmpegMocks.measureEbur128.mockResolvedValue({ integratedLufs: -20, truePeakDbtp: -3 });
  ffmpegMocks.measureClipping.mockResolvedValue({ clippedSamples: 0, peakDbfs: -5 });
  ffmpegMocks.measureOverallRmsDb.mockResolvedValue(-65);
});

async function seedStorageForChunks(chunks: FakeRow[]): Promise<InMemoryStorageProvider> {
  const storage = new InMemoryStorageProvider();
  for (const chunk of chunks) {
    const audioChunk = chunk.currentAudioChunk as FakeRow | null;
    if (audioChunk) {
      await storage.put({
        key: audioChunk.storageKey as string,
        body: Buffer.from('fake-wav-bytes'),
        contentType: 'audio/wav',
      });
    }
  }
  return storage;
}

describe('processAssembleChapterJob', () => {
  it('assembles chunks in chapterSequenceIndex order even when input array order is scrambled', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
      scope: null,
    });
    mock.chapters.set('chapter-1', { id: 'chapter-1', bookVersionId: 'bv-1', title: 'Chapter One' });

    const scrambled = [
      makeScriptChunk('sc-2', 'chapter-1', 2, makeAudioChunk('ac-2')),
      makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0')),
      makeScriptChunk('sc-1', 'chapter-1', 1, makeAudioChunk('ac-1')),
    ];
    mock.setAudioScriptChunks(scrambled);
    const storage = await seedStorageForChunks(scrambled);
    const queueManager = { enqueue: vi.fn() };

    await processAssembleChapterJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('chapter-1'),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.chapterAudios).toHaveLength(1);
    expect(mock.chapterAudios[0]).toMatchObject({ status: 'ASSEMBLED', chunkCount: 3 });

    const membersByOrder = [...mock.chapterAudioMembers].sort(
      (a, b) => (a.orderIndex as number) - (b.orderIndex as number),
    );
    expect(membersByOrder.map((m) => m.audioChunkId)).toEqual(['ac-0', 'ac-1', 'ac-2']);
    expect(membersByOrder.map((m) => m.orderIndex)).toEqual([0, 1, 2]);

    const eventTypes = mock.outboxMessages.map((m) => m.eventType);
    expect(eventTypes).toEqual(['chapter.assembly_started', 'chapter.completed']);
  });

  it('blocks the chapter with no ChapterAudio row when a chunk is missing or not VALIDATED', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
      scope: null,
    });
    mock.chapters.set('chapter-1', { id: 'chapter-1', bookVersionId: 'bv-1', title: 'Chapter One' });

    const chunks = [
      makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0')),
      makeScriptChunk('sc-1', 'chapter-1', 1, makeAudioChunk('ac-1', { status: 'GENERATED' })),
      makeScriptChunk('sc-2', 'chapter-1', 2, null),
    ];
    mock.setAudioScriptChunks(chunks);
    const storage = await seedStorageForChunks(chunks);
    const queueManager = { enqueue: vi.fn() };

    await processAssembleChapterJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('chapter-1'),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.chapterAudios).toHaveLength(0);
    expect(ffmpegMocks.probeAudio).not.toHaveBeenCalled();
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'FAILED', errorCode: 'CHAPTER_MANIFEST_INCOMPLETE' });
    expect(mock.outboxMessages.map((m) => m.eventType)).toEqual(['job.failed']);
    expect(mock.outboxMessages[0]!.payload).toMatchObject({
      error_code: 'CHAPTER_MANIFEST_INCOMPLETE',
      missing_chunk_ids: expect.arrayContaining(['sc-1', 'sc-2']),
    });
  });

  it('re-running with an identical manifest hash reuses the existing ChapterAudio and does no ffmpeg work', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
      scope: null,
    });
    mock.chapters.set('chapter-1', { id: 'chapter-1', bookVersionId: 'bv-1', title: 'Chapter One' });

    const chunks = [makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0'))];
    mock.setAudioScriptChunks(chunks);
    const storage = await seedStorageForChunks(chunks);

    // Pre-seed a ChapterAudio whose manifest hash matches exactly what this run will compute:
    // sha256("ac-0:hash-ac-0").
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update('ac-0:hash-ac-0').digest('hex');
    mock.chapterAudios.push({
      id: 'existing-chapter-audio',
      chapterId: 'chapter-1',
      chunkManifestHash: expectedHash,
      isPreviewBuild: false,
      version: 1,
      isCurrent: true,
      status: 'ASSEMBLED',
    });
    const queueManager = { enqueue: vi.fn() };

    await processAssembleChapterJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('chapter-1'),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.chapterAudios).toHaveLength(1); // no new row created
    expect(ffmpegMocks.probeAudio).not.toHaveBeenCalled();
    expect(ffmpegMocks.applyTwoPassLoudnorm).not.toHaveBeenCalled();
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({
      status: 'SUCCEEDED',
      resultResourceId: 'existing-chapter-audio',
    });
  });

  describe('audiobook fan-in trigger', () => {
    function setupTwoChapterBook(mock: ReturnType<typeof makeMockPrisma>, otherChapterReady: boolean) {
      mock.books.set('book-1', { id: 'book-1', currentBookVersionId: 'bv-1' });
      mock.chapters.set('chapter-1', { id: 'chapter-1', bookVersionId: 'bv-1', title: 'Chapter One' });
      mock.chapters.set('chapter-2', { id: 'chapter-2', bookVersionId: 'bv-1', title: 'Chapter Two' });
      if (otherChapterReady) {
        mock.chapterAudios.push({
          id: 'chapter-audio-2',
          chapterId: 'chapter-2',
          isCurrent: true,
          status: 'ASSEMBLED',
          version: 1,
        });
      }
    }

    it('does NOT trigger assemble_audiobook when another chapter is still incomplete', async () => {
      const mock = makeMockPrisma();
      mock.processingJobs.set('job-1', {
        id: 'job-1',
        tenantId: 'tenant-1',
        bookId: 'book-1',
        status: 'CREATED',
        correlationId: 'corr-1',
        priority: 'NORMAL',
        startedAt: null,
        scope: { scope: 'AUDIOBOOK', delivery_formats: ['M4B'] },
      });
      setupTwoChapterBook(mock, false);

      const chunks = [makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0'))];
      mock.setAudioScriptChunks(chunks);
      const storage = await seedStorageForChunks(chunks);
      const queueManager = { enqueue: vi.fn() };

      await processAssembleChapterJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: makeEnvelope('chapter-1'),
        queueManager: queueManager as never,
        attemptsMade: 0,
        maxAttempts: 3,
      });

      expect(queueManager.enqueue).not.toHaveBeenCalled();
      expect(mock.createdProcessingJobs.some((j) => j.type === 'assemble_audiobook')).toBe(false);
    });

    it('DOES trigger assemble_audiobook once this was truly the last incomplete chapter', async () => {
      const mock = makeMockPrisma();
      mock.processingJobs.set('job-1', {
        id: 'job-1',
        tenantId: 'tenant-1',
        bookId: 'book-1',
        status: 'CREATED',
        correlationId: 'corr-1',
        priority: 'NORMAL',
        startedAt: null,
        scope: { scope: 'AUDIOBOOK', delivery_formats: ['M4B'] },
      });
      setupTwoChapterBook(mock, true);

      const chunks = [makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0'))];
      mock.setAudioScriptChunks(chunks);
      const storage = await seedStorageForChunks(chunks);
      const queueManager = { enqueue: vi.fn() };

      await processAssembleChapterJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: makeEnvelope('chapter-1'),
        queueManager: queueManager as never,
        attemptsMade: 0,
        maxAttempts: 3,
      });

      expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
      const [queueName, envelope, options] = queueManager.enqueue.mock.calls[0]!;
      expect(queueName).toBe('audio');
      expect(envelope.payload).toMatchObject({ book_id: 'book-1', delivery_formats: ['M4B'] });
      expect(options).toMatchObject({ jobName: 'assemble_audiobook' });
      expect(mock.createdProcessingJobs.some((j) => j.type === 'assemble_audiobook')).toBe(true);
    });

    it('does NOT trigger assemble_audiobook for a lone CHAPTERS-scope re-assembly', async () => {
      const mock = makeMockPrisma();
      mock.processingJobs.set('job-1', {
        id: 'job-1',
        tenantId: 'tenant-1',
        bookId: 'book-1',
        status: 'CREATED',
        correlationId: 'corr-1',
        priority: 'NORMAL',
        startedAt: null,
        scope: { scope: 'CHAPTERS', delivery_formats: ['M4B'] },
      });
      setupTwoChapterBook(mock, true);

      const chunks = [makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0'))];
      mock.setAudioScriptChunks(chunks);
      const storage = await seedStorageForChunks(chunks);
      const queueManager = { enqueue: vi.fn() };

      await processAssembleChapterJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: makeEnvelope('chapter-1'),
        queueManager: queueManager as never,
        attemptsMade: 0,
        maxAttempts: 3,
      });

      expect(queueManager.enqueue).not.toHaveBeenCalled();
    });
  });

  it('marks the job FAILED and emits job.failed on a terminal pipeline error, without creating a ChapterAudio', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
      scope: null,
    });
    mock.chapters.set('chapter-1', { id: 'chapter-1', bookVersionId: 'bv-1', title: 'Chapter One' });
    const chunks = [makeScriptChunk('sc-0', 'chapter-1', 0, makeAudioChunk('ac-0'))];
    mock.setAudioScriptChunks(chunks);
    const storage = await seedStorageForChunks(chunks);
    ffmpegMocks.measureClipping.mockResolvedValueOnce({ clippedSamples: 5, peakDbfs: 0 });
    const queueManager = { enqueue: vi.fn() };

    await expect(
      processAssembleChapterJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: makeEnvelope('chapter-1'),
        queueManager: queueManager as never,
        attemptsMade: 2,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/clipping/i);

    expect(mock.chapterAudios).toHaveLength(0);
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'FAILED' });
    expect(mock.outboxMessages.map((m) => m.eventType)).toContain('job.failed');
  });
});
