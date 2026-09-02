import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '@audio-book/errors';
import { TtsService } from './tts.service.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [], scopes: [] };

const BOOK_ID = 'book-1';
const SCRIPT_ID = 'script-1';
const VOICE_VERSION_ID = 'voice-version-1';

interface Chunk {
  id: string;
  audioScriptId: string;
  bookId: string;
  chapterId: string;
  sequenceIndex: number;
  version: number;
  seed: bigint | null;
  sourceContentHash: string;
  targetSampleRate: number | null;
  targetChannels: number | null;
  voiceProfileVersionId: string | null;
  voiceProfileVersion: Record<string, unknown> | null;
}

function makeFakePrisma(overrides?: {
  scriptState?: string;
  chunks?: Chunk[];
  existingAudioChunks?: Record<string, unknown>[];
}) {
  const books = new Map<string, Record<string, unknown>>();
  books.set(BOOK_ID, {
    id: BOOK_ID,
    tenantId: 'tenant-1',
    currentAudioScriptId: SCRIPT_ID,
    status: 'SCRIPTED',
  });

  const script = {
    id: SCRIPT_ID,
    bookId: BOOK_ID,
    state: overrides?.scriptState ?? 'VALIDATED',
    sourceContentHash: 'h'.repeat(64),
  };

  const voiceVersion = {
    id: VOICE_VERSION_ID,
    voiceProfileId: 'profile-1',
    version: 1,
    approvalState: 'APPROVED',
    ttsProviderId: 'mock-tts',
    ttsModelVersionId: 'model-version-1',
    baseGenerationParams: {},
    baseGenerationParamsHash: 'a'.repeat(64),
  };

  const defaultChunks: Chunk[] = [
    {
      id: 'chunk-1',
      audioScriptId: SCRIPT_ID,
      bookId: BOOK_ID,
      chapterId: 'chapter-1',
      sequenceIndex: 0,
      version: 1,
      seed: 42n,
      sourceContentHash: 'c'.repeat(64),
      targetSampleRate: 24_000,
      targetChannels: 1,
      voiceProfileVersionId: VOICE_VERSION_ID,
      voiceProfileVersion: voiceVersion,
    },
  ];
  const chunks = overrides?.chunks ?? defaultChunks;

  const processingJobs: Record<string, unknown>[] = [];
  const ttsJobs: Record<string, unknown>[] = [];
  const existingAudioChunks = overrides?.existingAudioChunks ?? [];

  const tx = {
    processingJob: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        processingJobs.push(data);
        return Promise.resolve(data);
      }),
    },
    ttsJob: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        ttsJobs.push(data);
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
    audioScript: {
      findUniqueOrThrow: vi.fn(({ where }: { where: { id: string } }) => {
        if (where.id !== script.id) throw new Error('not found');
        return Promise.resolve(script);
      }),
    },
    audioScriptChunk: {
      findMany: vi.fn(() => Promise.resolve(chunks)),
    },
    audioChunk: {
      findMany: vi.fn(() => Promise.resolve(existingAudioChunks)),
      groupBy: vi.fn(() => Promise.resolve([])),
    },
    processingJob: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = processingJobs.find((j) => j.id === where.id);
        if (job) Object.assign(job, data);
        return Promise.resolve(job);
      }),
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, processingJobs, ttsJobs, books };
}

function makeService(overrides?: Parameters<typeof makeFakePrisma>[0]) {
  const { prisma, processingJobs, ttsJobs, books } = makeFakePrisma(overrides);
  const queueManager = { enqueue: vi.fn(() => Promise.resolve()) };
  const storage = { getSignedUrl: vi.fn(() => Promise.resolve('https://signed.example/x')) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new TtsService(
    prisma as never,
    queueManager as never,
    storage as never,
    logger as never,
  );
  return { service, processingJobs, ttsJobs, queueManager, books };
}

describe('TtsService.startTts', () => {
  it('creates a TtsJob + ProcessingJob per chunk and enqueues generate_tts_chunk', async () => {
    const { service, processingJobs, ttsJobs, queueManager, books } = makeService();

    const result = await service.startTts(principal, BOOK_ID, { scope: 'BOOK' });

    expect(result.accepted.planned_unit_count).toBe(1);
    // one coordinator job + one per-chunk job
    expect(processingJobs).toHaveLength(2);
    expect(ttsJobs).toHaveLength(1);
    expect(ttsJobs[0]).toMatchObject({
      audioScriptChunkId: 'chunk-1',
      status: 'PENDING',
      ttsModelVersionId: 'model-version-1',
    });
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
    expect(queueManager.enqueue).toHaveBeenCalledWith(
      'gpu',
      expect.objectContaining({ payload: { tts_job_id: ttsJobs[0]!.id } }),
      expect.objectContaining({ jobName: 'generate_tts_chunk' }),
    );
    expect(books.get(BOOK_ID)).toMatchObject({ status: 'GENERATING' });
  });

  it('rejects when the Audio Script is not VALIDATED', async () => {
    const { service } = makeService({ scriptState: 'DRAFT' });
    await expect(service.startTts(principal, BOOK_ID, { scope: 'BOOK' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('blocks with CASTING_INCOMPLETE when a chunk has no resolvable voice', async () => {
    const { service } = makeService({
      chunks: [
        {
          id: 'chunk-1',
          audioScriptId: SCRIPT_ID,
          bookId: BOOK_ID,
          chapterId: 'chapter-1',
          sequenceIndex: 0,
          version: 1,
          seed: null,
          sourceContentHash: 'c'.repeat(64),
          targetSampleRate: 24_000,
          targetChannels: 1,
          voiceProfileVersionId: null,
          voiceProfileVersion: null,
        },
      ],
    });
    try {
      await service.startTts(principal, BOOK_ID, { scope: 'BOOK' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('CASTING_INCOMPLETE');
    }
  });

  it('blocks with VOICE_PROFILE_NOT_APPROVED when the bound version is DRAFT', async () => {
    const { service } = makeService({
      chunks: [
        {
          id: 'chunk-1',
          audioScriptId: SCRIPT_ID,
          bookId: BOOK_ID,
          chapterId: 'chapter-1',
          sequenceIndex: 0,
          version: 1,
          seed: null,
          sourceContentHash: 'c'.repeat(64),
          targetSampleRate: 24_000,
          targetChannels: 1,
          voiceProfileVersionId: VOICE_VERSION_ID,
          voiceProfileVersion: {
            id: VOICE_VERSION_ID,
            approvalState: 'DRAFT',
            ttsModelVersionId: 'm',
            ttsProviderId: 'mock-tts',
            baseGenerationParams: {},
            baseGenerationParamsHash: 'a'.repeat(64),
            voiceProfileId: 'p',
          },
        },
      ],
    });
    try {
      await service.startTts(principal, BOOK_ID, { scope: 'BOOK' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('VOICE_PROFILE_NOT_APPROVED');
    }
  });

  it('skips a chunk whose current AudioChunk already matches lineage, unless forced', async () => {
    const { service, ttsJobs, queueManager } = makeService({
      existingAudioChunks: [
        {
          audioScriptChunkId: 'chunk-1',
          voiceProfileVersionId: VOICE_VERSION_ID,
          sourceContentHash: 'c'.repeat(64),
        },
      ],
    });

    const result = await service.startTts(principal, BOOK_ID, { scope: 'BOOK' });

    expect(result.accepted.planned_unit_count).toBe(0);
    expect(result.accepted.skipped_unit_count).toBe(1);
    expect(ttsJobs).toHaveLength(0);
    expect(queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('requires chunk_ids for scope CHUNKS', async () => {
    const { service } = makeService();
    await expect(service.startTts(principal, BOOK_ID, { scope: 'CHUNKS' })).rejects.toThrow(
      ValidationError,
    );
  });
});
