import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InMemoryStorageProvider } from '@audio-book/storage';
import { PACKAGING_POLICY_V1 } from '../lib/mastering-policy.js';

const ffmpegMocks = vi.hoisted(() => ({
  getFfmpegVersion: vi.fn(async () => '6.1.1'),
  probeAudio: vi.fn(async () => ({ durationMs: 3000, sampleRate: 44100, channels: 1, formatName: 'mov,mp4,m4a' })),
  probeChapters: vi.fn(async () => [] as { startMs: number; endMs: number; title: string | null }[]),
  encodeAac: vi.fn(async () => {}),
  encodeMp3: vi.fn(async () => {}),
  trimAndConvert: vi.fn(async () => {}),
  runFfprobeTags: vi.fn(async () => ({ title: 'The Great Book' }) as Record<string, string>),
  runFfprobeHasAttachedPic: vi.fn(async () => false),
}));

vi.mock('../lib/ffmpeg.js', () => ({
  getFfmpegVersion: ffmpegMocks.getFfmpegVersion,
  probeAudio: ffmpegMocks.probeAudio,
  probeChapters: ffmpegMocks.probeChapters,
  buildFfmetadataChapters: () => ';FFMETADATA1\n',
  encodeAac: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.encodeAac();
  },
  encodeMp3: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.encodeMp3();
  },
  trimAndConvert: async (_input: string, output: string) => {
    await writeFile(output, 'x');
    return ffmpegMocks.trimAndConvert();
  },
  runFfprobe: async (args: string[]) => {
    if (args.includes('-show_format')) {
      return { stdout: JSON.stringify({ format: { tags: await ffmpegMocks.runFfprobeTags() } }), stderr: '' };
    }
    if (args.includes('-show_streams')) {
      const hasArt = await ffmpegMocks.runFfprobeHasAttachedPic();
      return {
        stdout: JSON.stringify({
          streams: hasArt ? [{ codec_type: 'video', disposition: { attached_pic: 1 } }] : [],
        }),
        stderr: '',
      };
    }
    return { stdout: '{}', stderr: '' };
  },
}));

const { processEncodeDeliveryFormatJob } = await import('./assembly-encode.js');

interface FakeRow {
  [key: string]: unknown;
}

function makeMockPrisma() {
  const processingJobs = new Map<string, FakeRow>();
  const audiobooks = new Map<string, FakeRow>();
  const books = new Map<string, FakeRow>();
  const audiobookChapters: FakeRow[] = [];
  const audiobookRenditions: FakeRow[] = [];
  const modelRegistries = new Map<string, FakeRow>();
  const modelVersions = new Map<string, FakeRow>();
  const outboxMessages: FakeRow[] = [];
  const jobUpdates: FakeRow[] = [];

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
      findMany: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          [...processingJobs.values()]
            .filter(
              (j) =>
                j.type === where.type &&
                j.relatedResourceType === where.relatedResourceType &&
                j.relatedResourceId === where.relatedResourceId,
            )
            .map((j) => ({ scope: j.scope })),
        ),
      ),
    },
    audiobook: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(audiobooks.get(where.id) ?? null)),
      update: vi.fn(({ where, data }: { where: { id: string }; data: FakeRow }) => {
        const row = audiobooks.get(where.id);
        if (!row) throw new Error(`Audiobook ${where.id} not found`);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    // The encode job points the Book at its finished audiobook in the same
    // transaction that marks it READY (F-16), so the fake tx needs `book`.
    book: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: FakeRow }) => {
        const row = books.get(where.id) ?? {};
        Object.assign(row, data);
        books.set(where.id, row);
        return Promise.resolve(row);
      }),
    },
    audiobookChapter: {
      findMany: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          audiobookChapters
            .filter((c) => c.audiobookId === where.audiobookId)
            .sort((a, b) => (a.orderIndex as number) - (b.orderIndex as number)),
        ),
      ),
    },
    audiobookRendition: {
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          audiobookRenditions.find(
            (r) =>
              r.audiobookId === where.audiobookId &&
              r.format === where.format &&
              (where.status === undefined || r.status === where.status) &&
              (where.chapterId === undefined || r.chapterId === where.chapterId),
          ) ?? null,
        ),
      ),
      findMany: vi.fn(({ where }: { where: FakeRow }) => {
        let matched = audiobookRenditions.filter((r) => r.audiobookId === where.audiobookId);
        if (where.format) matched = matched.filter((r) => r.format === where.format);
        if (where.status) matched = matched.filter((r) => r.status === where.status);
        if (where.chapterId && typeof where.chapterId === 'object' && 'not' in (where.chapterId as FakeRow)) {
          matched = matched.filter((r) => r.chapterId !== null);
        }
        return Promise.resolve(matched);
      }),
      create: vi.fn(({ data }: { data: FakeRow }) => {
        audiobookRenditions.push(data);
        return Promise.resolve(data);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: FakeRow }) => {
        const row = audiobookRenditions.find((r) => r.id === where.id);
        if (!row) throw new Error(`AudiobookRendition ${where.id} not found`);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    audiobookCover: {
      findUnique: vi.fn(() => Promise.resolve(null)),
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
    audiobooks,
    audiobookChapters,
    audiobookRenditions,
    outboxMessages,
    jobUpdates,
  };
}

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;

function makeEnvelope(
  audiobookId: string,
  format: 'M4B' | 'M4A' | 'MP3_PER_CHAPTER',
  jobId = 'encode-job-1',
) {
  return {
    job_id: 'msg-1',
    entity_id: jobId,
    correlation_id: 'corr-1',
    tenant_id: 'tenant-1',
    payload: { audiobook_id: audiobookId, format },
  };
}

function seedRequestedFormats(mock: ReturnType<typeof makeMockPrisma>, audiobookId: string, formats: string[]) {
  for (const format of formats) {
    const id = `sibling-encode-job-${format}`;
    mock.processingJobs.set(id, {
      id,
      type: 'encode_delivery_format',
      relatedResourceType: 'audiobook',
      relatedResourceId: audiobookId,
      scope: { format },
    });
  }
}

function makeAudiobook(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'audiobook-1',
    tenantId: 'tenant-1',
    bookId: 'book-1',
    version: 1,
    status: 'ASSEMBLING',
    storageKey: 'tenant-1/books/book-1/audiobook/v1-master.wav',
    durationMs: 3000,
    chapterCount: 1,
    metadataTitle: 'The Great Book',
    metadataAuthor: 'Jane Author',
    audiobookCoverId: null,
    bookWer: null,
    audioToolModelVersionId: 'audio-tool-mv-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  ffmpegMocks.getFfmpegVersion.mockResolvedValue('6.1.1');
  ffmpegMocks.probeAudio.mockResolvedValue({ durationMs: 3000, sampleRate: 44100, channels: 1, formatName: 'mov,mp4,m4a' });
  ffmpegMocks.probeChapters.mockResolvedValue([]);
  ffmpegMocks.runFfprobeTags.mockResolvedValue({ title: 'The Great Book' });
  ffmpegMocks.runFfprobeHasAttachedPic.mockResolvedValue(false);
});

async function seedMasterStorage(audiobookId: string): Promise<InMemoryStorageProvider> {
  const storage = new InMemoryStorageProvider();
  await storage.put({
    key: `tenant-1/books/book-1/audiobook/v1-master.wav`,
    body: Buffer.from('fake-master-wav'),
    contentType: 'audio/wav',
  });
  void audiobookId;
  return storage;
}

describe('processEncodeDeliveryFormatJob', () => {
  it('idempotency: short-circuits an already-READY rendition under the current packaging policy, doing no encode work', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('encode-job-1', {
      id: 'encode-job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    mock.audiobooks.set('audiobook-1', makeAudiobook());
    mock.audiobookRenditions.push({
      id: 'rendition-1',
      audiobookId: 'audiobook-1',
      format: 'M4B',
      chapterId: null,
      status: 'READY',
      encodeParams: { policy_version: PACKAGING_POLICY_V1.version },
      sizeBytes: 1000n,
    });
    seedRequestedFormats(mock, 'audiobook-1', ['M4B']);
    const storage = await seedMasterStorage('audiobook-1');

    await processEncodeDeliveryFormatJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('audiobook-1', 'M4B'),
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(ffmpegMocks.encodeAac).not.toHaveBeenCalled();
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'SUCCEEDED' });
    // Only one format was ever requested and it's READY -> publication gate flips to READY.
    expect(mock.audiobooks.get('audiobook-1')).toMatchObject({ status: 'READY' });
    expect(mock.outboxMessages.map((m) => m.eventType)).toContain('audiobook.completed');
  });

  it('Audiobook.status only reaches READY once every requested format has a READY rendition', async () => {
    const mock = makeMockPrisma();
    mock.audiobooks.set('audiobook-1', makeAudiobook({ chapterCount: 0 }));
    seedRequestedFormats(mock, 'audiobook-1', ['M4B', 'M4A']);
    const storage = await seedMasterStorage('audiobook-1');

    // --- Encode M4B first: Audiobook must NOT be READY yet (M4A still pending). ---
    mock.processingJobs.set('encode-job-1', {
      id: 'encode-job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    await processEncodeDeliveryFormatJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('audiobook-1', 'M4B', 'encode-job-1'),
      attemptsMade: 0,
      maxAttempts: 3,
    });
    expect(mock.audiobooks.get('audiobook-1')).toMatchObject({ status: 'ASSEMBLING' });
    expect(mock.outboxMessages.map((m) => m.eventType)).not.toContain('audiobook.completed');

    // --- Encode M4A second: now every requested format is READY. ---
    mock.processingJobs.set('encode-job-2', {
      id: 'encode-job-2',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    await processEncodeDeliveryFormatJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: makeEnvelope('audiobook-1', 'M4A', 'encode-job-2'),
      attemptsMade: 0,
      maxAttempts: 3,
    });
    expect(mock.audiobooks.get('audiobook-1')).toMatchObject({ status: 'READY' });
    expect(mock.outboxMessages.map((m) => m.eventType)).toContain('audiobook.completed');
    const completedEvent = mock.outboxMessages.find((m) => m.eventType === 'audiobook.completed')!;
    expect((completedEvent.payload as FakeRow).available_formats).toEqual(['M4B', 'M4A']);
  });

  it('verification failure: does not persist the rendition as READY, flips Audiobook to FAILED, emits audiobook.failed', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('encode-job-1', {
      id: 'encode-job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    mock.audiobooks.set('audiobook-1', makeAudiobook({ chapterCount: 0, durationMs: 3000 }));
    seedRequestedFormats(mock, 'audiobook-1', ['M4B']);
    const storage = await seedMasterStorage('audiobook-1');

    // Encoded output reports a wildly different duration than the audiobook master -> verification fails.
    ffmpegMocks.probeAudio.mockResolvedValueOnce({
      durationMs: 30000,
      sampleRate: 44100,
      channels: 1,
      formatName: 'mov,mp4,m4a',
    });

    await expect(
      processEncodeDeliveryFormatJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: makeEnvelope('audiobook-1', 'M4B'),
        attemptsMade: 2,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/duration mismatch/i);

    expect(mock.audiobookRenditions.some((r) => r.status === 'READY')).toBe(false);
    expect(mock.audiobooks.get('audiobook-1')).toMatchObject({ status: 'FAILED' });
    expect(mock.outboxMessages.map((m) => m.eventType)).toContain('audiobook.failed');
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'FAILED' });
  });
});
