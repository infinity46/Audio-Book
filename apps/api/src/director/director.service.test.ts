import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@audio-book/errors';
import { DirectorService } from './director.service.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [], scopes: [] };

const BOOK_ID = 'book-1';
const BOOK_VERSION_ID = 'book-version-1';

function makeFakePrisma() {
  const books = new Map<string, Record<string, unknown>>();
  const bookVersions = new Map<string, Record<string, unknown>>();
  const storyBibles = new Map<string, Record<string, unknown>>();
  const chapters: Record<string, unknown>[] = [];
  const processingJobs: Record<string, unknown>[] = [];
  const audioScripts: Record<string, unknown>[] = [];
  const audioScriptChunks = new Map<string, Record<string, unknown>>();
  const voiceProfileVersions = new Map<string, Record<string, unknown>>();

  books.set(BOOK_ID, {
    id: BOOK_ID,
    tenantId: 'tenant-1',
    currentBookVersionId: BOOK_VERSION_ID,
    status: 'ANALYZED',
  });
  bookVersions.set(BOOK_VERSION_ID, {
    id: BOOK_VERSION_ID,
    status: 'READY',
    contentHash: 'a'.repeat(64),
    structureVersionLabel: 'structure.v1',
  });
  storyBibles.set(BOOK_ID, {
    bookId: BOOK_ID,
    status: 'READY',
    currentVersionId: 'sbv-1',
    currentVersionNumber: 1,
  });
  chapters.push({
    id: 'chapter-1',
    bookVersionId: BOOK_VERSION_ID,
    matterType: 'BODY',
    orderIndex: 0,
  });
  chapters.push({
    id: 'chapter-2',
    bookVersionId: BOOK_VERSION_ID,
    matterType: 'BODY',
    orderIndex: 1,
  });

  const tx = {
    processingJob: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        processingJobs.push(data);
        return Promise.resolve(data);
      }),
    },
    book: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = books.get(where.id) ?? {};
        books.set(where.id, { ...current, ...data });
        return Promise.resolve(books.get(where.id));
      }),
    },
  };

  const prisma = {
    book: {
      findFirst: vi.fn(({ where }: { where: { id: string; tenantId: string } }) => {
        const row = books.get(where.id);
        return Promise.resolve(row && row.tenantId === where.tenantId ? row : null);
      }),
    },
    bookVersion: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(bookVersions.get(where.id) ?? null),
      ),
    },
    storyBible: {
      findUnique: vi.fn(({ where }: { where: { bookId: string } }) =>
        Promise.resolve(storyBibles.get(where.bookId) ?? null),
      ),
    },
    chapter: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let result = chapters.filter((c) => c.bookVersionId === where.bookVersionId);
        if (where.matterType) result = result.filter((c) => c.matterType === where.matterType);
        if (where.id && typeof where.id === 'object' && 'in' in where.id) {
          const ids = (where.id as { in: string[] }).in;
          result = result.filter((c) => ids.includes(c.id as string));
        }
        return Promise.resolve(result);
      }),
    },
    processingJob: {
      findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        const types = (where.type as { in: string[] } | undefined)?.in ?? [];
        const statuses = (where.status as { in: string[] } | undefined)?.in ?? [];
        return Promise.resolve(
          processingJobs.find(
            (j) =>
              j.bookId === where.bookId &&
              types.includes(j.type as string) &&
              statuses.includes(j.status as string),
          ) ?? null,
        );
      }),
      create: tx.processingJob.create,
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = processingJobs.find((j) => j.id === where.id);
        if (job) Object.assign(job, data);
        return Promise.resolve(job);
      }),
    },
    audioScript: {
      findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          audioScripts.find(
            (s) =>
              s.bookId === where.bookId &&
              (where.isCurrent === undefined || s.isCurrent === where.isCurrent),
          ) ?? null,
        ),
      ),
    },
    audioScriptChunk: {
      findFirst: vi.fn(
        ({ where }: { where: { id: string; bookId: string; isCurrent?: boolean } }) => {
          const row = audioScriptChunks.get(where.id);
          return Promise.resolve(row && row.bookId === where.bookId ? row : null);
        },
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = audioScriptChunks.get(where.id) ?? {};
        const merged = { ...current, ...data };
        audioScriptChunks.set(where.id, merged);
        return Promise.resolve(merged);
      }),
    },
    voiceProfileVersion: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(voiceProfileVersions.get(where.id) ?? null),
      ),
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return {
    prisma,
    books,
    processingJobs,
    audioScripts,
    audioScriptChunks,
    voiceProfileVersions,
  };
}

function makeService() {
  const { prisma, books, processingJobs, audioScripts, audioScriptChunks, voiceProfileVersions } =
    makeFakePrisma();
  const queueManager = {
    enqueue: vi.fn(
      (_queue: string, _envelope: { payload: Record<string, unknown> }, _opts?: unknown) =>
        Promise.resolve(),
    ),
  };
  const logger = { info: vi.fn() };
  const service = new DirectorService(prisma as never, queueManager as never, logger as never);
  return {
    service,
    prisma,
    queueManager,
    books,
    processingJobs,
    audioScripts,
    audioScriptChunks,
    voiceProfileVersions,
  };
}

describe('DirectorService.startDirector preconditions', () => {
  it('rejects when the book has no ingested version', async () => {
    const { service, books } = makeService();
    books.set(BOOK_ID, { ...books.get(BOOK_ID), currentBookVersionId: null });
    await expect(
      service.startDirector(principal, BOOK_ID, { scope: 'BOOK' }),
    ).rejects.toMatchObject({ code: 'INGESTION_NOT_COMPLETE' });
  });

  it('rejects when the Story Bible is not READY', async () => {
    const { service, prisma } = makeService();
    (prisma.storyBible.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      bookId: BOOK_ID,
      status: 'BUILDING',
      currentVersionId: null,
    });
    await expect(
      service.startDirector(principal, BOOK_ID, { scope: 'BOOK' }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_NOT_COMPLETE' });
  });

  it('rejects when a Director job is already running for this book', async () => {
    const { service, processingJobs } = makeService();
    processingJobs.push({
      bookId: BOOK_ID,
      type: 'generate_director_ir',
      status: 'RUNNING',
    });
    await expect(
      service.startDirector(principal, BOOK_ID, { scope: 'BOOK' }),
    ).rejects.toMatchObject({ code: 'DIRECTOR_ALREADY_RUNNING' });
  });

  it('rejects a CHAPTERS scope request naming more than one chapter', async () => {
    const { service } = makeService();
    await expect(
      service.startDirector(principal, BOOK_ID, {
        scope: 'CHAPTERS',
        chapter_ids: ['chapter-1', 'chapter-2'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects director_version mixing unless explicitly acknowledged', async () => {
    const { service, audioScripts } = makeService();
    audioScripts.push({
      id: 'as-1',
      bookId: BOOK_ID,
      isCurrent: true,
      directorVersion: 'director.v0',
    });
    await expect(
      service.startDirector(principal, BOOK_ID, { scope: 'BOOK', director_version: 'director.v1' }),
    ).rejects.toMatchObject({ code: 'DIRECTOR_VERSION_MIXING_FORBIDDEN' });
  });

  it('allows version mixing when explicitly acknowledged', async () => {
    const { service, audioScripts, queueManager } = makeService();
    audioScripts.push({
      id: 'as-1',
      bookId: BOOK_ID,
      isCurrent: true,
      directorVersion: 'director.v0',
    });
    const result = await service.startDirector(principal, BOOK_ID, {
      scope: 'BOOK',
      director_version: 'director.v1',
      acknowledge_version_mixing: true,
    });
    expect(result.job.status).toBe('CREATED');
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('DirectorService.startDirector happy path', () => {
  it('creates a generate_director_ir job scoped to the whole book and enqueues it on the ai queue', async () => {
    const { service, processingJobs, queueManager, books } = makeService();
    const result = await service.startDirector(principal, BOOK_ID, { scope: 'BOOK' });

    expect(result.job.type).toBe('generate_director_ir');
    expect(result.accepted.planned_unit_count).toBe(2); // two BODY chapters
    expect(processingJobs).toHaveLength(1);
    expect(processingJobs[0]).toMatchObject({ type: 'generate_director_ir', queue: 'ai' });
    expect(books.get(BOOK_ID)?.status).toBe('SCRIPTING');

    const call = queueManager.enqueue.mock.calls[0]!;
    expect(call[0]).toBe('ai');
    expect(call[1].payload).toMatchObject({
      book_id: BOOK_ID,
      audio_script_id: null,
      chapter_id: 'chapter-1',
      remaining_chapter_ids: ['chapter-2'],
    });
    expect(call[2]).toMatchObject({ jobName: 'generate_director_ir' });
  });
});

describe('DirectorService.updateAudioScriptChunk', () => {
  it('rejects editing a LOCKED chunk with AUDIO_SCRIPT_CHUNK_FROZEN', async () => {
    const { service, audioScriptChunks } = makeService();
    audioScriptChunks.set('chunk-1', {
      id: 'chunk-1',
      bookId: BOOK_ID,
      isCurrent: true,
      state: 'LOCKED',
    });
    await expect(
      service.updateAudioScriptChunk(principal, BOOK_ID, 'chunk-1', {
        performance: { emotion: 'ANGRY' },
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_SCRIPT_CHUNK_FROZEN' });
  });

  it('rejects reassigning to a voice_profile_version_id that is not APPROVED or LOCKED', async () => {
    const { service, audioScriptChunks, voiceProfileVersions } = makeService();
    audioScriptChunks.set('chunk-1', {
      id: 'chunk-1',
      bookId: BOOK_ID,
      isCurrent: true,
      state: 'DRAFT',
      directorOriginal: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    voiceProfileVersions.set('voice-v1', { id: 'voice-v1', approvalState: 'DRAFT' });
    await expect(
      service.updateAudioScriptChunk(principal, BOOK_ID, 'chunk-1', {
        voice_binding: { voice_profile_version_id: 'voice-v1' },
      }),
    ).rejects.toMatchObject({ code: 'VOICE_PROFILE_NOT_APPROVED' });
  });

  it('sets origin to HUMAN_MODIFIED and preserves the original value only on the first edit', async () => {
    const { service, audioScriptChunks } = makeService();
    audioScriptChunks.set('chunk-1', {
      id: 'chunk-1',
      bookId: BOOK_ID,
      isCurrent: true,
      state: 'DRAFT',
      emotion: 'NEUTRAL',
      directorOriginal: null,
      rowVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const first = await service.updateAudioScriptChunk(principal, BOOK_ID, 'chunk-1', {
      performance: { emotion: 'ANGRY' },
      reason: 'misclassified',
    });
    expect(first.provenance.origin).toBe('HUMAN_MODIFIED');
    expect(first.provenance.director_original).toMatchObject({ emotion: 'NEUTRAL' });

    // A second edit must not overwrite the already-recorded original value.
    const second = await service.updateAudioScriptChunk(principal, BOOK_ID, 'chunk-1', {
      performance: { emotion: 'SAD' },
    });
    expect(second.provenance.director_original).toMatchObject({ emotion: 'NEUTRAL' });
  });
});

describe('DirectorService tenant isolation', () => {
  it('returns NotFoundError for a book owned by a different tenant', async () => {
    const { service } = makeService();
    const otherPrincipal = { sub: 'user-2', tenantId: 'tenant-2', roles: [], scopes: [] };
    await expect(service.getCurrentAudioScript(otherPrincipal, BOOK_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
