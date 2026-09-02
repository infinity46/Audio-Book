import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InMemoryStorageProvider } from '@audio-book/storage';

const ffmpegMocks = vi.hoisted(() => ({
  getFfmpegVersion: vi.fn(async () => '6.1.1'),
  probeAudio: vi.fn(async (_path: string) => ({ durationMs: 1000, sampleRate: 24000, channels: 1, formatName: 'wav' })),
  measureEbur128: vi.fn(async (_path: string) => ({ integratedLufs: -20, truePeakDbtp: -3 })),
  applyGainAndConvert: vi.fn(async () => {}),
  writeConcatFileList: vi.fn(async () => {}),
  concatDemuxCopy: vi.fn(async () => {}),
}));

vi.mock('../lib/ffmpeg.js', () => ({
  getFfmpegVersion: ffmpegMocks.getFfmpegVersion,
  probeAudio: ffmpegMocks.probeAudio,
  measureEbur128: ffmpegMocks.measureEbur128,
  applyGainAndConvert: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.applyGainAndConvert();
  },
  writeConcatFileList: ffmpegMocks.writeConcatFileList,
  concatDemuxCopy: async (_listPath: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.concatDemuxCopy();
  },
}));

const { processAssembleAudiobookJob } = await import('./assembly-audiobook.js');

interface FakeRow {
  [key: string]: unknown;
}

function makeMockPrisma() {
  const processingJobs = new Map<string, FakeRow>();
  const books = new Map<string, FakeRow>();
  const chapters = new Map<string, FakeRow>(); // id -> row (has bookVersionId, orderIndex, title)
  const chapterAudios: FakeRow[] = []; // has chapterId, isCurrent, status, id, contentHash, directorVersion, storageKey
  const audiobooks: FakeRow[] = [];
  const audiobookChapters: FakeRow[] = [];
  const audiobookRenditions: FakeRow[] = [];
  const bookVersions = new Map<string, FakeRow>();
  const audioScriptChunks: FakeRow[] = [];
  const audioChunks: FakeRow[] = [];
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
      create: vi.fn(({ data }: { data: FakeRow }) => {
        processingJobs.set(data.id as string, data);
        createdProcessingJobs.push(data);
        return Promise.resolve(data);
      }),
    },
    book: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(books.get(where.id) ?? null)),
    },
    chapter: {
      count: vi.fn(({ where }: { where: FakeRow }) => {
        const inVersion = [...chapters.values()].filter((c) => c.bookVersionId === where.bookVersionId);
        if (where.chapterAudios) {
          return Promise.resolve(
            inVersion.filter(
              (c) =>
                !chapterAudios.some(
                  (ca) => ca.chapterId === c.id && ca.isCurrent === true && ca.status === 'ASSEMBLED',
                ),
            ).length,
          );
        }
        return Promise.resolve(inVersion.length);
      }),
      findMany: vi.fn(({ where }: { where: FakeRow }) => {
        const matched = [...chapters.values()]
          .filter((c) => c.bookVersionId === where.bookVersionId)
          .sort((a, b) => (a.orderIndex as number) - (b.orderIndex as number));
        return Promise.resolve(
          matched.map((c) => ({
            ...c,
            chapterAudios: chapterAudios.filter(
              (ca) => ca.chapterId === c.id && ca.isCurrent === true && ca.status === 'ASSEMBLED',
            ),
          })),
        );
      }),
    },
    audiobook: {
      findFirst: vi.fn(({ where }: { where: FakeRow }) => {
        const statusFilter = where.status as { notIn: string[] } | undefined;
        const matched = audiobooks.filter(
          (a) =>
            a.bookVersionId === where.bookVersionId &&
            a.chapterManifestHash === where.chapterManifestHash &&
            (!statusFilter || !statusFilter.notIn.includes(a.status as string)),
        );
        matched.sort((a, b) => (b.version as number) - (a.version as number));
        return Promise.resolve(matched[0] ?? null);
      }),
      aggregate: vi.fn(({ where }: { where: FakeRow }) => {
        const versions = audiobooks.filter((a) => a.bookId === where.bookId).map((a) => a.version as number);
        return Promise.resolve({ _max: { version: versions.length ? Math.max(...versions) : null } });
      }),
      updateMany: vi.fn(({ where, data }: { where: FakeRow; data: FakeRow }) => {
        const matched = audiobooks.filter((a) => a.bookId === where.bookId && a.isCurrent === where.isCurrent);
        for (const a of matched) Object.assign(a, data);
        return Promise.resolve({ count: matched.length });
      }),
      create: vi.fn(({ data }: { data: FakeRow }) => {
        audiobooks.push(data);
        return Promise.resolve(data);
      }),
    },
    audiobookChapter: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        audiobookChapters.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    audiobookRendition: {
      count: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          audiobookRenditions.filter(
            (r) => r.audiobookId === where.audiobookId && r.format === where.format && r.status === where.status,
          ).length,
        ),
      ),
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          audiobookRenditions.find(
            (r) =>
              r.audiobookId === where.audiobookId &&
              r.format === where.format &&
              r.status === where.status &&
              r.chapterId === where.chapterId,
          ) ?? null,
        ),
      ),
    },
    bookVersion: {
      findUniqueOrThrow: vi.fn(({ where }: { where: { id: string } }) => {
        const row = bookVersions.get(where.id);
        if (!row) throw new Error(`BookVersion ${where.id} not found`);
        return Promise.resolve(row);
      }),
    },
    audioScriptChunk: {
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          audioScriptChunks.find((c) => c.bookId === where.bookId && c.isCurrent === where.isCurrent) ?? null,
        ),
      ),
    },
    audioChunk: {
      findMany: vi.fn(({ where }: { where: FakeRow }) => {
        const chapterIdFilter = (where.chapterId as { in: string[] }).in;
        const matched = audioChunks.filter(
          (c) => chapterIdFilter.includes(c.chapterId as string) && c.isCurrent === where.isCurrent,
        );
        const seen = new Set<string>();
        const distinct: FakeRow[] = [];
        for (const row of matched) {
          if (!seen.has(row.ttsModelVersionId as string)) {
            seen.add(row.ttsModelVersionId as string);
            distinct.push({ ttsModelVersionId: row.ttsModelVersionId });
          }
        }
        return Promise.resolve(distinct);
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
    books,
    chapters,
    chapterAudios,
    audiobooks,
    audiobookChapters,
    audiobookRenditions,
    bookVersions,
    audioScriptChunks,
    audioChunks,
    outboxMessages,
    jobUpdates,
    createdProcessingJobs,
  };
}

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;

function makeEnvelope(bookId: string, deliveryFormats: string[], jobId = 'job-1') {
  return {
    job_id: 'msg-1',
    entity_id: jobId,
    correlation_id: 'corr-1',
    tenant_id: 'tenant-1',
    payload: { book_id: bookId, delivery_formats: deliveryFormats },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ffmpegMocks.getFfmpegVersion.mockResolvedValue('6.1.1');
  ffmpegMocks.measureEbur128.mockResolvedValue({ integratedLufs: -20, truePeakDbtp: -3 });
});

/** Sets up a 3-chapter, fully-ASSEMBLED book ready for audiobook assembly. */
async function setupReadyBook(mock: ReturnType<typeof makeMockPrisma>, chapterDurationsMs: number[]) {
  mock.books.set('book-1', {
    id: 'book-1',
    currentBookVersionId: 'bv-1',
    title: 'The Great Book',
    author: 'Jane Author',
    language: 'en',
    description: null,
    series: null,
    seriesIndex: null,
    publisher: null,
    publicationYear: null,
  });
  mock.bookVersions.set('bv-1', { id: 'bv-1', contentHash: 'content-hash-1' });
  mock.audioScriptChunks.push({
    bookId: 'book-1',
    isCurrent: true,
    sequenceIndex: 0,
    storyBibleVersionId: 'sbv-1',
  });

  const storage = new InMemoryStorageProvider();
  for (let i = 0; i < chapterDurationsMs.length; i++) {
    const chapterId = `chapter-${i}`;
    const chapterAudioId = `ca-${i}`;
    mock.chapters.set(chapterId, { id: chapterId, bookVersionId: 'bv-1', orderIndex: i, title: `Chapter ${i + 1}` });
    mock.chapterAudios.push({
      id: chapterAudioId,
      chapterId,
      isCurrent: true,
      status: 'ASSEMBLED',
      contentHash: `hash-${chapterAudioId}`,
      directorVersion: 'director.v1',
      storageKey: `tenant-1/books/book-1/chapters/${chapterId}/audio/v1.wav`,
    });
    await storage.put({
      key: `tenant-1/books/book-1/chapters/${chapterId}/audio/v1.wav`,
      body: Buffer.from('fake-chapter-wav'),
      contentType: 'audio/wav',
    });
    mock.audioChunks.push({ chapterId, isCurrent: true, ttsModelVersionId: 'ttsmv-1' });
  }

  ffmpegMocks.probeAudio.mockImplementation(async (path: string) => {
    const rawMatch = /chapter-(\d+)-raw\.wav$/.exec(path);
    if (rawMatch) {
      const i = Number(rawMatch[1]);
      return { durationMs: chapterDurationsMs[i]!, sampleRate: 24000, channels: 1, formatName: 'wav' };
    }
    if (path.endsWith('audiobook-master.wav')) {
      return {
        durationMs: chapterDurationsMs.reduce((a, b) => a + b, 0),
        sampleRate: 24000,
        channels: 1,
        formatName: 'wav',
      };
    }
    return { durationMs: 1000, sampleRate: 24000, channels: 1, formatName: 'wav' };
  });

  return storage;
}

describe('processAssembleAudiobookJob', () => {
  it('computes AudiobookChapter start timestamps as exact sums of preceding chapter durations', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
    });
    const storage = await setupReadyBook(mock, [1000, 2000, 1500]);
    const queueManager = { enqueue: vi.fn() };

    await processAssembleAudiobookJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('book-1', ['M4B']),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.audiobooks).toHaveLength(1);
    const chaptersByOrder = [...mock.audiobookChapters].sort(
      (a, b) => (a.orderIndex as number) - (b.orderIndex as number),
    );
    expect(chaptersByOrder.map((c) => c.startMs)).toEqual([0, 1000, 3000]);
    expect(chaptersByOrder.map((c) => c.durationMs)).toEqual([1000, 2000, 1500]);

    expect(mock.audiobooks[0]).toMatchObject({ status: 'ASSEMBLING', metadataTitle: 'The Great Book' });
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
    expect(queueManager.enqueue.mock.calls[0]![2]).toMatchObject({ jobName: 'encode_delivery_format' });
  });

  it('is not ready when a chapter has no current ASSEMBLED ChapterAudio: fails cleanly, creates no Audiobook', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
    });
    const storage = await setupReadyBook(mock, [1000, 2000]);
    // Knock the second chapter out of ASSEMBLED.
    mock.chapterAudios.find((ca) => ca.chapterId === 'chapter-1')!.status = 'ASSEMBLING';
    const queueManager = { enqueue: vi.fn() };

    await processAssembleAudiobookJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('book-1', ['M4B']),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.audiobooks).toHaveLength(0);
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'FAILED', errorCode: 'CHAPTER_MANIFEST_INCOMPLETE' });
    expect(queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('resumability: an existing Audiobook with a missing format triggers only the missing format, no re-assembly', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      priority: 'NORMAL',
      startedAt: null,
    });
    const storage = await setupReadyBook(mock, [1000, 2000]);

    // Compute the manifest hash exactly as the processor does, and pre-seed a matching Audiobook.
    const { createHash } = await import('node:crypto');
    const manifestHash = createHash('sha256')
      .update(['ca-0:hash-ca-0', 'ca-1:hash-ca-1'].join('\n'))
      .digest('hex');
    mock.audiobooks.push({
      id: 'existing-audiobook',
      bookId: 'book-1',
      bookVersionId: 'bv-1',
      chapterManifestHash: manifestHash,
      status: 'ASSEMBLING',
      version: 1,
    });
    // M4B already READY; MP3_PER_CHAPTER is missing.
    mock.audiobookRenditions.push({
      audiobookId: 'existing-audiobook',
      format: 'M4B',
      status: 'READY',
      chapterId: null,
    });
    const queueManager = { enqueue: vi.fn() };

    await processAssembleAudiobookJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('book-1', ['M4B', 'MP3_PER_CHAPTER']),
      queueManager: queueManager as never,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.audiobooks).toHaveLength(1); // no new Audiobook row — no re-concatenation
    expect(ffmpegMocks.concatDemuxCopy).not.toHaveBeenCalled();
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
    const [, envelope] = queueManager.enqueue.mock.calls[0]!;
    expect(envelope.payload).toMatchObject({ audiobook_id: 'existing-audiobook', format: 'MP3_PER_CHAPTER' });
    // Filter to job-1's own updates — enqueueProcessingJob now also stamps
    // queuedAt on the newly-created encode_delivery_format job's row, which
    // can be the chronologically-last jobUpdates entry overall.
    const finalJobUpdate = mock.jobUpdates
      .filter((u) => (u.where as { id: string }).id === 'job-1')
      .at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'SUCCEEDED', resultResourceId: 'existing-audiobook' });
  });
});
