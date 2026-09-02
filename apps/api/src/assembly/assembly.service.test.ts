import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { AssemblyService } from './assembly.service.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [], scopes: [] };

const BOOK_ID = 'book-1';
const BOOK_VERSION_ID = 'book-version-1';
const CHAPTER_1 = 'chapter-1';
const CHAPTER_2 = 'chapter-2';

interface Row {
  [key: string]: unknown;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const condObj = cond as Record<string, unknown>;
      if ('in' in condObj) return (condObj.in as unknown[]).includes(value);
      if ('gt' in condObj) return typeof value === 'number' && value > (condObj.gt as number);
      if ('lt' in condObj) return typeof value === 'number' && value < (condObj.lt as number);
      // Relation shorthand, e.g. { chapter: { orderIndex: { gt: 3 } } } or
      // { renditions: { some: {...} } } — resolved by the caller-supplied
      // `row[key]` already being the joined sub-object/array in our fixtures.
      if ('some' in condObj) {
        const arr = (value as Row[] | undefined) ?? [];
        return arr.some((item) => matches(item, condObj.some as Row));
      }
      return matches((value as Row) ?? {}, condObj);
    }
    return value === cond;
  });
}

function makeFakePrisma(overrides?: {
  book?: Partial<Row>;
  bookVersion?: Row | null;
  storyBible?: Row | null;
  chapters?: Row[];
  scriptChunks?: Row[];
  chapterAudios?: Row[];
  audiobooks?: Row[];
  renditions?: Row[];
}) {
  const book: Row = {
    id: BOOK_ID,
    tenantId: 'tenant-1',
    title: 'The Lighthouse',
    author: 'Jules Verne',
    language: 'en',
    currentBookVersionId: BOOK_VERSION_ID,
    ...overrides?.book,
  };

  const bookVersion: Row | null =
    overrides?.bookVersion !== undefined
      ? overrides.bookVersion
      : { id: BOOK_VERSION_ID, contentHash: 'bv'.repeat(32) };
  const storyBible: Row | null =
    overrides?.storyBible !== undefined ? overrides.storyBible : { bookId: BOOK_ID, currentVersionId: 'sbv-1' };

  const chapters: Row[] =
    overrides?.chapters ?? [
      { id: CHAPTER_1, bookId: BOOK_ID, bookVersionId: BOOK_VERSION_ID, orderIndex: 0, title: 'Ch 1' },
      { id: CHAPTER_2, bookId: BOOK_ID, bookVersionId: BOOK_VERSION_ID, orderIndex: 1, title: 'Ch 2' },
    ];

  const scriptChunks: Row[] =
    overrides?.scriptChunks ??
    chapters.flatMap((c, chapterIdx) =>
      [0, 1].map((i) => ({
        id: `chunk-${chapterIdx}-${i}`,
        chapterId: c.id,
        chapterSequenceIndex: i,
        isCurrent: true,
        directorVersion: 'director.v1',
        currentAudioChunk: {
          id: `audio-chunk-${chapterIdx}-${i}`,
          status: 'VALIDATED',
          contentHash: `hash-${chapterIdx}-${i}`.padEnd(64, '0'),
        },
      })),
    );

  const chapterAudios: Row[] = overrides?.chapterAudios ?? [];
  const audiobooks: Row[] = overrides?.audiobooks ?? [];
  const renditions: Row[] = overrides?.renditions ?? [];
  const processingJobs: Row[] = [];
  const audiobookCovers: Row[] = [];

  const tx = {
    processingJob: {
      create: vi.fn(({ data }: { data: Row }) => {
        processingJobs.push(data);
        return Promise.resolve(data);
      }),
    },
    book: {
      update: vi.fn(({ data }: { data: Row }) => {
        Object.assign(book, data);
        return Promise.resolve(book);
      }),
    },
    audiobookCover: {
      create: vi.fn(({ data }: { data: Row }) => {
        audiobookCovers.push(data);
        return Promise.resolve(data);
      }),
    },
    audiobook: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: Row }) => {
        const row = audiobooks.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };

  const prisma = {
    book: {
      findFirst: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(matches(book, where) ? book : null),
      ),
      update: tx.book.update,
    },
    bookVersion: {
      findUnique: vi.fn(() => Promise.resolve(bookVersion)),
    },
    storyBible: {
      findUnique: vi.fn(() => Promise.resolve(storyBible)),
    },
    chapter: {
      findMany: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(chapters.filter((c) => matches(c, where))),
      ),
    },
    audioScriptChunk: {
      findMany: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(scriptChunks.filter((c) => matches(c, where))),
      ),
    },
    chapterAudio: {
      findMany: vi.fn(({ where }: { where: Row }) => {
        const joined = chapterAudios.map((ca) => ({
          ...ca,
          chapter: chapters.find((c) => c.id === ca.chapterId),
        }));
        const filtered = joined.filter((c) => matches(c, where));
        // The service always orders chapter-audio reads by the parent
        // chapter's order_index — mirror that here rather than modelling
        // Prisma's general orderBy semantics.
        filtered.sort(
          (a, b) => ((a.chapter?.orderIndex as number) ?? 0) - ((b.chapter?.orderIndex as number) ?? 0),
        );
        return Promise.resolve(filtered);
      }),
      findFirst: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(chapterAudios.find((c) => matches(c, where)) ?? null),
      ),
    },
    audiobook: {
      findFirst: vi.fn(({ where }: { where: Row }) => {
        const joined = audiobooks.map((a) => ({
          ...a,
          chapters: [],
          renditions: renditions.filter((r) => r.audiobookId === a.id),
          cover: audiobookCovers.find((c) => c.id === a.audiobookCoverId) ?? null,
        }));
        return Promise.resolve(joined.find((a) => matches(a, where)) ?? null);
      }),
      findMany: vi.fn(({ where }: { where: Row }) => {
        const joined = audiobooks.map((a) => ({
          ...a,
          chapters: [],
          renditions: renditions.filter((r) => r.audiobookId === a.id),
          cover: audiobookCovers.find((c) => c.id === a.audiobookCoverId) ?? null,
        }));
        return Promise.resolve(joined.filter((a) => matches(a, where)));
      }),
      count: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(audiobooks.filter((a) => matches(a, where)).length),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Row }) => {
        const row = audiobooks.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve({ ...row, chapters: [], renditions: [], cover: null });
      }),
    },
    audiobookRendition: {
      findMany: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(renditions.filter((r) => matches(r, where))),
      ),
      findFirst: vi.fn(({ where }: { where: Row }) =>
        Promise.resolve(renditions.find((r) => matches(r, where)) ?? null),
      ),
    },
    processingJob: {
      create: vi.fn(({ data }: { data: Row }) => {
        processingJobs.push(data);
        return Promise.resolve(data);
      }),
      findFirst: vi.fn(() => Promise.resolve(null)),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Row }) => {
        const job = processingJobs.find((j) => j.id === where.id);
        if (job) Object.assign(job, data);
        return Promise.resolve(job);
      }),
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, book, chapters, scriptChunks, chapterAudios, audiobooks, processingJobs, renditions };
}

function makeService(overrides?: Parameters<typeof makeFakePrisma>[0]) {
  const { prisma, book, chapters, scriptChunks, chapterAudios, audiobooks, processingJobs, renditions } =
    makeFakePrisma(overrides);
  const queueManager = { enqueue: vi.fn(() => Promise.resolve()) };
  const storage = {
    getSignedUrl: vi.fn(() => Promise.resolve('https://signed.example/x')),
    get: vi.fn(),
    put: vi.fn(() => Promise.resolve({ bucket: 'test-bucket' })),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coverSessions = {
    create: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(null)),
    delete: vi.fn(() => Promise.resolve()),
  };
  const service = new AssemblyService(
    prisma as never,
    queueManager as never,
    storage as never,
    logger as never,
    coverSessions as never,
  );
  return {
    service,
    prisma,
    book,
    chapters,
    scriptChunks,
    chapterAudios,
    audiobooks,
    processingJobs,
    renditions,
    queueManager,
    storage,
    coverSessions,
  };
}

describe('AssemblyService.startAssembly', () => {
  it('creates one assemble_chapter ProcessingJob per chapter and enqueues on the audio queue', async () => {
    const { service, processingJobs, queueManager, book } = makeService();

    const result = await service.startAssembly(principal, BOOK_ID, { scope: 'AUDIOBOOK' });

    expect(processingJobs).toHaveLength(2);
    expect(processingJobs.every((j) => j.type === 'assemble_chapter')).toBe(true);
    expect(queueManager.enqueue).toHaveBeenCalledTimes(2);
    expect(queueManager.enqueue).toHaveBeenCalledWith(
      'audio',
      expect.objectContaining({ payload: { chapter_id: CHAPTER_1 } }),
      expect.objectContaining({ jobName: 'assemble_chapter' }),
    );
    expect(result.accepted.planned_unit_count).toBe(2);
    expect(result.accepted.chapter_ids).toEqual(expect.arrayContaining([CHAPTER_1, CHAPTER_2]));
    expect(book.status).toBe('ASSEMBLING');
  });

  it('requires chapter_ids for scope CHAPTER', async () => {
    const { service } = makeService();
    await expect(service.startAssembly(principal, BOOK_ID, { scope: 'CHAPTER' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('blocks with CHAPTER_MANIFEST_INCOMPLETE when a chunk is not VALIDATED, unless allow_partial_preview', async () => {
    const { service } = makeService({
      scriptChunks: [
        {
          id: 'chunk-0-0',
          chapterId: CHAPTER_1,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v1',
          currentAudioChunk: { id: 'ac-1', status: 'GENERATED', contentHash: 'h'.repeat(64) },
        },
        {
          id: 'chunk-1-0',
          chapterId: CHAPTER_2,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v1',
          currentAudioChunk: { id: 'ac-2', status: 'VALIDATED', contentHash: 'h'.repeat(64) },
        },
      ],
    });

    try {
      await service.startAssembly(principal, BOOK_ID, { scope: 'AUDIOBOOK' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('CHAPTER_MANIFEST_INCOMPLETE');
    }
  });

  it('with allow_partial_preview, excludes incomplete chapters and reports them as blocking', async () => {
    const { service, processingJobs } = makeService({
      scriptChunks: [
        {
          id: 'chunk-0-0',
          chapterId: CHAPTER_1,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v1',
          currentAudioChunk: { id: 'ac-1', status: 'GENERATED', contentHash: 'h'.repeat(64) },
        },
        {
          id: 'chunk-1-0',
          chapterId: CHAPTER_2,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v1',
          currentAudioChunk: { id: 'ac-2', status: 'VALIDATED', contentHash: 'h'.repeat(64) },
        },
      ],
    });

    const result = await service.startAssembly(principal, BOOK_ID, {
      scope: 'AUDIOBOOK',
      allow_partial_preview: true,
    });

    expect(result.accepted.blocking).toEqual([CHAPTER_1]);
    expect(result.accepted.chapter_ids).toEqual([CHAPTER_2]);
    expect(processingJobs).toHaveLength(1);
    expect(processingJobs[0]!.relatedResourceId).toBe(CHAPTER_2);
  });

  it('blocks with DIRECTOR_VERSION_MIXING_FORBIDDEN when chunks disagree on director_version', async () => {
    const { service } = makeService({
      scriptChunks: [
        {
          id: 'chunk-0-0',
          chapterId: CHAPTER_1,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v1',
          currentAudioChunk: { id: 'ac-1', status: 'VALIDATED', contentHash: 'h'.repeat(64) },
        },
        {
          id: 'chunk-1-0',
          chapterId: CHAPTER_2,
          chapterSequenceIndex: 0,
          isCurrent: true,
          directorVersion: 'director.v2',
          currentAudioChunk: { id: 'ac-2', status: 'VALIDATED', contentHash: 'h'.repeat(64) },
        },
      ],
    });

    try {
      await service.startAssembly(principal, BOOK_ID, { scope: 'AUDIOBOOK' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('DIRECTOR_VERSION_MIXING_FORBIDDEN');
    }
  });

  it('rejects scope AUDIOBOOK when book metadata is insufficient', async () => {
    const { service } = makeService({ book: { author: null } });
    try {
      await service.startAssembly(principal, BOOK_ID, { scope: 'AUDIOBOOK' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('VALIDATION_FAILED');
    }
  });

  it('skips a chapter whose current ChapterAudio manifest hash already matches, unless forced', async () => {
    // Compute the same hash the service will: sha256 of ordered "id:contentHash" joined by \n.
    const { createHash } = await import('node:crypto');
    const hash = (pairs: [string, string][]) =>
      createHash('sha256').update(pairs.map(([id, h]) => `${id}:${h}`).join('\n')).digest('hex');

    const matchingHash = hash([
      ['audio-chunk-0-0', 'hash-0-0'.padEnd(64, '0')],
      ['audio-chunk-0-1', 'hash-0-1'.padEnd(64, '0')],
    ]);

    const { service, processingJobs, queueManager } = makeService({
      chapterAudios: [
        {
          id: 'ca-1',
          chapterId: CHAPTER_1,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          chunkManifestHash: matchingHash,
          contentHash: 'ca-hash-1'.padEnd(64, '0'),
          durationMs: 1000,
        },
      ],
    });

    const result = await service.startAssembly(principal, BOOK_ID, { scope: 'CHAPTER', chapter_ids: [CHAPTER_1] });

    expect(result.accepted.chapter_ids).toEqual([]);
    expect(result.accepted.skipped_chapter_ids).toEqual([CHAPTER_1]);
    expect(processingJobs).toHaveLength(0);
    expect(queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('for scope AUDIOBOOK, enqueues assemble_audiobook directly when every chapter is already assembled', async () => {
    const { createHash } = await import('node:crypto');
    const hash = (pairs: [string, string][]) =>
      createHash('sha256').update(pairs.map(([id, h]) => `${id}:${h}`).join('\n')).digest('hex');
    const hash1 = hash([
      ['audio-chunk-0-0', 'hash-0-0'.padEnd(64, '0')],
      ['audio-chunk-0-1', 'hash-0-1'.padEnd(64, '0')],
    ]);
    const hash2 = hash([
      ['audio-chunk-1-0', 'hash-1-0'.padEnd(64, '0')],
      ['audio-chunk-1-1', 'hash-1-1'.padEnd(64, '0')],
    ]);

    const { service, processingJobs, queueManager } = makeService({
      chapterAudios: [
        {
          id: 'ca-1',
          chapterId: CHAPTER_1,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          chunkManifestHash: hash1,
          contentHash: 'ca-hash-1'.padEnd(64, '0'),
          durationMs: 1000,
        },
        {
          id: 'ca-2',
          chapterId: CHAPTER_2,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          chunkManifestHash: hash2,
          contentHash: 'ca-hash-2'.padEnd(64, '0'),
          durationMs: 1000,
        },
      ],
    });

    const result = await service.startAssembly(principal, BOOK_ID, { scope: 'AUDIOBOOK' });

    expect(result.accepted.chapter_ids).toEqual([]);
    expect(result.accepted.audiobook_job_id).not.toBeNull();
    expect(result.accepted.planned_unit_count).toBe(1);
    expect(processingJobs).toHaveLength(1);
    expect(processingJobs[0]!.type).toBe('assemble_audiobook');
    expect(queueManager.enqueue).toHaveBeenCalledWith(
      'audio',
      expect.objectContaining({ payload: { book_id: BOOK_ID, delivery_formats: ['M4B'] } }),
      expect.objectContaining({ jobName: 'assemble_audiobook' }),
    );
  });
});

describe('AssemblyService.getAssemblyState', () => {
  it('reports real chapter counts, never fabricated', async () => {
    const { service } = makeService({
      chapterAudios: [
        {
          id: 'ca-1',
          chapterId: CHAPTER_1,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          voiceConsistencyVerified: true,
        },
      ],
    });

    const state = await service.getAssemblyState(principal, BOOK_ID);
    expect(state.chapters_total).toBe(2);
    expect(state.chapters_assembled).toBe(1);
    expect(state.blocking).toEqual([CHAPTER_2]);
  });
});

describe('AssemblyService chapter audio reads', () => {
  it('lists current chapter audio ordered by chapter order_index', async () => {
    const { service } = makeService({
      chapterAudios: [
        {
          id: 'ca-2',
          chapterId: CHAPTER_2,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          version: 1,
          durationMs: 500,
          chunkCount: 2,
          chunkManifestHash: 'h'.repeat(64),
          format: 'WAV',
          integratedLufs: -19,
          truePeakDbtp: -3,
          directorVersion: 'director.v1',
          pipelineVersion: 'pipeline.v1',
          audioToolModelVersionId: 'ffmpeg-1',
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'ca-1',
          chapterId: CHAPTER_1,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLED',
          version: 1,
          durationMs: 400,
          chunkCount: 2,
          chunkManifestHash: 'h'.repeat(64),
          format: 'WAV',
          integratedLufs: -19,
          truePeakDbtp: -3,
          directorVersion: 'director.v1',
          pipelineVersion: 'pipeline.v1',
          audioToolModelVersionId: 'ffmpeg-1',
          createdAt: new Date('2026-01-01'),
        },
      ],
    });

    const page = await service.listChapterAudio(principal, BOOK_ID, {});
    expect(page.data.map((d) => d.id)).toEqual(['ca-1', 'ca-2']);
    expect(page.data[0]).not.toHaveProperty('storage_key');
  });

  it('getChapterAudio throws NotFoundError for a missing id', async () => {
    const { service } = makeService();
    await expect(service.getChapterAudio(principal, BOOK_ID, 'missing')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('createChapterAudioAccessUrl rejects when the track is not ASSEMBLED', async () => {
    const { service } = makeService({
      chapterAudios: [
        {
          id: 'ca-1',
          chapterId: CHAPTER_1,
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'ASSEMBLING',
          storageKey: 'k',
          format: 'WAV',
          contentHash: 'h'.repeat(64),
        },
      ],
    });
    try {
      await service.createChapterAudioAccessUrl(principal, BOOK_ID, 'ca-1', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('ARTIFACT_NOT_READY');
    }
  });
});

describe('AssemblyService.getAudiobookProject', () => {
  it('reports NOT_STARTED when no Audiobook exists yet', async () => {
    const { service } = makeService();
    const project = await service.getAudiobookProject(principal, BOOK_ID);
    expect(project.generation_status).toBe('NOT_STARTED');
    expect(project.current_audiobook_id).toBeNull();
    expect(project.totals.chapters).toBe(2);
  });

  it('reports STALE when the current Audiobook lineage no longer matches the book', async () => {
    const { service } = makeService({
      audiobooks: [
        {
          id: 'ab-1',
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'READY',
          version: 1,
          sourceContentHash: 'stale-hash'.padEnd(64, '0'),
          storyBibleVersionId: 'sbv-1',
          containerFormat: 'M4B',
          createdAt: new Date('2026-01-01'),
        },
      ],
    });
    const project = await service.getAudiobookProject(principal, BOOK_ID);
    expect(project.generation_status).toBe('STALE');
  });

  it('reports COMPLETED when the current Audiobook is READY and lineage matches', async () => {
    const { service } = makeService({
      audiobooks: [
        {
          id: 'ab-1',
          bookId: BOOK_ID,
          isCurrent: true,
          status: 'READY',
          version: 1,
          sourceContentHash: 'bv'.repeat(32),
          storyBibleVersionId: 'sbv-1',
          containerFormat: 'M4B',
          createdAt: new Date('2026-01-01'),
        },
      ],
    });
    const project = await service.getAudiobookProject(principal, BOOK_ID);
    expect(project.generation_status).toBe('COMPLETED');
  });
});

describe('AssemblyService audiobook artifacts', () => {
  function fullAudiobookRow(overrides?: Row): Row {
    return {
      id: 'ab-1',
      bookId: BOOK_ID,
      isCurrent: true,
      status: 'READY',
      version: 1,
      containerFormat: 'M4B',
      durationMs: 1000,
      sizeBytes: 2000n,
      metadataTitle: 'The Lighthouse',
      metadataAuthor: 'Jules Verne',
      metadataNarratorCredit: 'AI-narrated',
      aiNarrationDisclosed: true,
      metadataSeries: null,
      metadataSeriesIndex: null,
      metadataPublisher: null,
      metadataLanguage: 'en',
      metadataPublicationYear: null,
      metadataDescription: null,
      bookWer: 0.01,
      chunksFlagged: 0,
      asrCoverage: 0.1,
      pipelineVersion: 'pipeline.v1',
      directorVersion: 'director.v1',
      ttsModelVersionIds: ['m-1'],
      audioToolModelVersionId: 'ffmpeg-1',
      sourceContentHash: 'h'.repeat(64),
      storageKey: 'k',
      contentHash: 'h'.repeat(64),
      createdAt: new Date('2026-01-01'),
      ...overrides,
    };
  }

  it('getAudiobook returns a full DTO with metadata, cover, and lineage', async () => {
    const { service } = makeService({ audiobooks: [fullAudiobookRow()] });
    const dto = await service.getAudiobook(principal, BOOK_ID, 'ab-1');
    expect(dto.metadata.title).toBe('The Lighthouse');
    expect(dto.metadata.ai_narration_disclosed).toBe(true);
    expect(dto.cover).toEqual({ present: false });
    expect(dto.available_formats).toEqual(['M4B']);
  });

  it('updateAudiobookMetadata 409s with AUDIOBOOK_IMMUTABLE once the audiobook is READY', async () => {
    const { service } = makeService({ audiobooks: [fullAudiobookRow({ status: 'READY' })] });
    try {
      await service.updateAudiobookMetadata(principal, BOOK_ID, 'ab-1', { title: 'New Title' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('AUDIOBOOK_IMMUTABLE');
    }
  });

  it('createAudiobookAccessUrl 409s FORMAT_NOT_AVAILABLE for a format with no READY rendition', async () => {
    const { service } = makeService({ audiobooks: [fullAudiobookRow()] });
    try {
      await service.createAudiobookAccessUrl(principal, BOOK_ID, 'ab-1', { format: 'MP3_PER_CHAPTER' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('FORMAT_NOT_AVAILABLE');
    }
  });

  it('createAudiobookAccessUrl succeeds for the primary container format', async () => {
    const { service, storage } = makeService({ audiobooks: [fullAudiobookRow()] });
    const url = await service.createAudiobookAccessUrl(principal, BOOK_ID, 'ab-1', {});
    expect(url.format).toBe('M4B');
    expect(storage.getSignedUrl).toHaveBeenCalledWith('k', 'GET', 300);
  });
});

describe('AssemblyService.putAudiobookCover — DRAFT_METADATA gap', () => {
  it('409s AUDIOBOOK_IMMUTABLE against a READY audiobook (this pipeline never creates DRAFT_METADATA ones)', async () => {
    const { service } = makeService({
      audiobooks: [{ id: 'ab-1', bookId: BOOK_ID, status: 'READY', isCurrent: true }],
    });
    try {
      await service.putAudiobookCover(principal, BOOK_ID, 'ab-1', {
        declared_mime_type: 'image/png',
        declared_size_bytes: 1000,
        declared_content_hash: { algorithm: 'SHA256', value: 'h'.repeat(64) },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('AUDIOBOOK_IMMUTABLE');
    }
  });

  it('initiates an upload session when the audiobook is DRAFT_METADATA', async () => {
    const { service, coverSessions } = makeService({
      audiobooks: [{ id: 'ab-1', bookId: BOOK_ID, status: 'DRAFT_METADATA', isCurrent: true }],
    });
    const result = await service.putAudiobookCover(principal, BOOK_ID, 'ab-1', {
      declared_mime_type: 'image/png',
      declared_size_bytes: 1000,
      declared_content_hash: { algorithm: 'SHA256', value: 'h'.repeat(64) },
    });
    expect(result.status).toBe(201);
    expect((result.body as { status: string }).status).toBe('AWAITING_UPLOAD');
    expect(coverSessions.create).toHaveBeenCalledTimes(1);
  });
});
