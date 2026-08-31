import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InMemoryStorageProvider } from '@audio-book/storage';
import type { IngestionResult } from '@audio-book/ingestion';
import { CorruptedFileError } from '@audio-book/ingestion';

const { mockRunIngestionPipeline } = vi.hoisted(() => ({ mockRunIngestionPipeline: vi.fn() }));

vi.mock('@audio-book/ingestion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-book/ingestion')>();
  return { ...actual, runIngestionPipeline: mockRunIngestionPipeline };
});

const { processIngestionJob } = await import('./ingestion.js');

function sampleResult(overrides: Partial<IngestionResult> = {}): IngestionResult {
  return {
    sourceKind: 'PDF',
    chapters: [
      {
        orderIndex: 0,
        spineStart: 0,
        spineEnd: 1,
        title: 'Chapter 1',
        matterType: 'BODY',
        sections: [],
        paragraphs: [
          {
            orderIndex: 0,
            spinePosition: 0,
            text: 'First paragraph.',
            rawText: 'First paragraph.',
            sourcePageNumber: 1,
            sourcePageEndNumber: 1,
            sourceLocator: { kind: 'pdf', page: 1, blockIndex: 0 },
            extractionMethod: 'DIGITAL_TEXT',
          },
          {
            orderIndex: 1,
            spinePosition: 1,
            text: 'Second paragraph.',
            rawText: 'Second paragraph.',
            sourcePageNumber: 1,
            sourcePageEndNumber: 1,
            sourceLocator: { kind: 'pdf', page: 1, blockIndex: 1 },
            extractionMethod: 'DIGITAL_TEXT',
          },
        ],
      },
    ],
    pages: [{ pageNumber: 1, extractionMethod: 'DIGITAL_TEXT', status: 'OK', charCount: 34 }],
    warnings: [],
    qualityReport: { outcome: 'PASS', checks: [] },
    parserIdentity: { providerId: 'pdfjs-dist', modelId: 'pdf-text-extractor', version: '4.9.155' },
    ocrIdentity: null,
    normalizationVersion: 'normalize.v1',
    configHash: 'a'.repeat(64),
    rawTextContentHash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    markdown: '# Chapter 1\n\nFirst paragraph.\n\nSecond paragraph.\n',
    metadata: {},
    ...overrides,
  };
}

interface FakeRow {
  [key: string]: unknown;
}

function makeMockPrisma() {
  const processingJobs = new Map<string, FakeRow>();
  const bookFiles = new Map<string, FakeRow>();
  const modelRegistries = new Map<string, FakeRow>();
  const modelVersions = new Map<string, FakeRow>();
  const books = new Map<string, FakeRow>();
  const bookVersions: FakeRow[] = [];
  const chapters: FakeRow[] = [];
  const sections: FakeRow[] = [];
  const paragraphs: FakeRow[] = [];
  const parsedPages: FakeRow[] = [];
  const outboxMessages: FakeRow[] = [];
  const bookUpdates: FakeRow[] = [];
  const jobUpdates: FakeRow[] = [];

  function seedModelVersion(role: string, providerId: string, modelId: string, version: string) {
    const registryId = `registry-${role}-${providerId}-${modelId}`;
    modelRegistries.set(`${role}:${providerId}:${modelId}`, {
      id: registryId,
      role,
      providerId,
      modelId,
    });
    const versionId = `version-${registryId}-${version}`;
    modelVersions.set(`${registryId}:${version}`, {
      id: versionId,
      modelRegistryId: registryId,
      version,
    });
  }

  const tx = {
    bookVersion: {
      findFirst: vi.fn(({ where }: { where: FakeRow }) =>
        Promise.resolve(
          bookVersions.find(
            (v) =>
              v.bookId === where.bookId &&
              v.pipelineVersion === where.pipelineVersion &&
              v.contentHash === where.contentHash &&
              v.supersededAt === null,
          ) ?? null,
        ),
      ),
      create: vi.fn(({ data }: { data: FakeRow }) => {
        bookVersions.push({ ...data, supersededAt: null });
        return Promise.resolve(data);
      }),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    parsedPage: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        parsedPages.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    chapter: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        chapters.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    section: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        sections.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    paragraph: {
      createMany: vi.fn(({ data }: { data: FakeRow[] }) => {
        paragraphs.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    book: {
      update: vi.fn(({ where, data }: { where: FakeRow; data: FakeRow }) => {
        bookUpdates.push({ where, data });
        books.set(where.id as string, { ...books.get(where.id as string), ...data });
        return Promise.resolve(data);
      }),
    },
    processingJob: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(processingJobs.get(where.id) ?? null),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: FakeRow }) => {
        jobUpdates.push({ where, data });
        const current = processingJobs.get(where.id) ?? {};
        processingJobs.set(where.id, { ...current, ...data });
        return Promise.resolve(processingJobs.get(where.id));
      }),
    },
    outboxMessage: {
      create: vi.fn(({ data }: { data: FakeRow }) => {
        outboxMessages.push(data);
        return Promise.resolve(data);
      }),
    },
  };

  const prisma = {
    processingJob: tx.processingJob,
    bookFile: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(bookFiles.get(where.id) ?? null),
      ),
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
    bookVersion: {
      aggregate: vi.fn(() => Promise.resolve({ _max: { version: null } })),
      findFirst: tx.bookVersion.findFirst,
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return {
    prisma,
    seedModelVersion,
    processingJobs,
    bookFiles,
    bookVersions,
    chapters,
    sections,
    paragraphs,
    parsedPages,
    outboxMessages,
    bookUpdates,
    jobUpdates,
  };
}

const baseEnvelope = {
  job_id: 'outbox-msg-1',
  entity_id: 'job-1',
  correlation_id: 'corr-1',
  tenant_id: 'tenant-1',
  payload: { book_file_id: 'file-1', parser_version: '1' },
};

const logger = { info: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  mockRunIngestionPipeline.mockReset();
  mockRunIngestionPipeline.mockResolvedValue(sampleResult());
});

describe('processIngestionJob', () => {
  it('persists chapters/paragraphs, marks the job SUCCEEDED, and emits book.parsed + book.structure_ready', async () => {
    const mock = makeMockPrisma();
    mock.seedModelVersion('PARSER', 'pdfjs-dist', 'pdf-text-extractor', '4.9.155');
    mock.seedModelVersion('NORMALIZER', 'audio-book-normalizer', 'text-normalizer', 'normalize.v1');
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
      progressStage: null,
    });
    mock.bookFiles.set('file-1', {
      id: 'file-1',
      storageKey: 'tenant-1/books/book-1/source/v1.pdf',
      mimeType: 'application/pdf',
      sniffedMimeType: 'application/pdf',
    });

    const storage = new InMemoryStorageProvider();
    await storage.put({
      key: 'tenant-1/books/book-1/source/v1.pdf',
      body: Buffer.from('%PDF-fake'),
      contentType: 'application/pdf',
    });

    await processIngestionJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: baseEnvelope,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.chapters).toHaveLength(1);
    expect(mock.paragraphs).toHaveLength(2);
    expect(mock.parsedPages).toHaveLength(1);
    expect(mock.bookVersions).toHaveLength(1);
    expect(mock.bookVersions[0]).toMatchObject({ status: 'READY', contentHash: 'c'.repeat(64) });

    const eventTypes = mock.outboxMessages.map((m) => m.eventType);
    expect(eventTypes).toEqual(['book.parsed', 'book.structure_ready']);

    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({ status: 'SUCCEEDED' });

    expect(mock.bookUpdates.at(-1)!.data).toMatchObject({
      status: 'STRUCTURED',
      needsReview: false,
    });
  });

  it('resolves and records the OCR model version only on pages that were actually OCR’d, in a mixed digital+OCR book', async () => {
    const mock = makeMockPrisma();
    mock.seedModelVersion('PARSER', 'pdfjs-dist', 'pdf-text-extractor', '4.9.155');
    mock.seedModelVersion('NORMALIZER', 'audio-book-normalizer', 'text-normalizer', 'normalize.v1');
    mock.seedModelVersion('OCR', 'tesseract.js', 'tesseract-eng', '5.1.1');
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
      progressStage: null,
    });
    mock.bookFiles.set('file-1', {
      id: 'file-1',
      storageKey: 'tenant-1/books/book-1/source/v1.pdf',
      mimeType: 'application/pdf',
      sniffedMimeType: 'application/pdf',
    });

    const storage = new InMemoryStorageProvider();
    await storage.put({
      key: 'tenant-1/books/book-1/source/v1.pdf',
      body: Buffer.from('%PDF-fake'),
      contentType: 'application/pdf',
    });

    mockRunIngestionPipeline.mockResolvedValueOnce(
      sampleResult({
        ocrIdentity: { providerId: 'tesseract.js', modelId: 'tesseract-eng', version: '5.1.1' },
        pages: [
          { pageNumber: 1, extractionMethod: 'DIGITAL_TEXT', status: 'OK', charCount: 34 },
          { pageNumber: 2, extractionMethod: 'OCR', status: 'OK', charCount: 20, confidence: 0.9 },
        ],
      }),
    );

    await processIngestionJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: baseEnvelope,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.bookVersions[0]!.ocrModelVersionId).toBeTruthy();
    const digitalPage = mock.parsedPages.find((p) => p.pageNumber === 1)!;
    const ocrPage = mock.parsedPages.find((p) => p.pageNumber === 2)!;
    expect(digitalPage.ocrModelVersionId).toBeNull();
    expect(ocrPage.ocrModelVersionId).toBeTruthy();
    expect(ocrPage.ocrModelVersionId).toBe(mock.bookVersions[0]!.ocrModelVersionId);
  });

  it('is idempotent: redelivery of an already-SUCCEEDED job is a safe no-op', async () => {
    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      status: 'SUCCEEDED',
      tenantId: 'tenant-1',
      bookId: 'book-1',
    });

    await processIngestionJob({
      prisma: mock.prisma as never,
      storage: new InMemoryStorageProvider(),
      logger,
      envelope: baseEnvelope,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mockRunIngestionPipeline).not.toHaveBeenCalled();
    expect(mock.bookVersions).toHaveLength(0);
  });

  it('reuses an existing BookVersion when the same content was already ingested under this pipeline version', async () => {
    const mock = makeMockPrisma();
    mock.seedModelVersion('PARSER', 'pdfjs-dist', 'pdf-text-extractor', '4.9.155');
    mock.seedModelVersion('NORMALIZER', 'audio-book-normalizer', 'text-normalizer', 'normalize.v1');
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    mock.bookFiles.set('file-1', {
      id: 'file-1',
      storageKey: 'k',
      mimeType: 'application/pdf',
      sniffedMimeType: 'application/pdf',
    });
    mock.bookVersions.push({
      id: 'existing-version',
      bookId: 'book-1',
      pipelineVersion: 'ingestion.v1',
      contentHash: 'c'.repeat(64),
      supersededAt: null,
      version: 1,
    });

    const storage = new InMemoryStorageProvider();
    await storage.put({ key: 'k', body: Buffer.from('%PDF-fake'), contentType: 'application/pdf' });

    await processIngestionJob({
      prisma: mock.prisma as never,
      storage,
      logger,
      envelope: baseEnvelope,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(mock.bookVersions).toHaveLength(1); // no new row created
    expect(mock.chapters).toHaveLength(0); // structure not re-persisted
    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({
      status: 'SUCCEEDED',
      resultResourceId: 'existing-version',
    });
  });

  it('records a terminal failure and emits book.parse_failed without retry bookkeeping', async () => {
    mockRunIngestionPipeline.mockRejectedValue(new CorruptedFileError({ message: 'bad file' }));

    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    mock.bookFiles.set('file-1', { id: 'file-1', storageKey: 'k', mimeType: 'application/pdf' });

    const storage = new InMemoryStorageProvider();
    await storage.put({ key: 'k', body: Buffer.from('%PDF-fake'), contentType: 'application/pdf' });

    await expect(
      processIngestionJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: baseEnvelope,
        attemptsMade: 0,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(CorruptedFileError);

    const finalJobUpdate = mock.jobUpdates.at(-1)!;
    expect(finalJobUpdate.data).toMatchObject({
      status: 'FAILED',
      errorTerminal: true,
      errorRetryable: false,
    });
    expect(mock.outboxMessages.map((m) => m.eventType)).toEqual(['book.parse_failed']);
    expect(mock.bookUpdates.at(-1)!.data).toMatchObject({ status: 'FAILED' });
  });

  it('does not record a terminal failure on a retryable error before the final attempt', async () => {
    mockRunIngestionPipeline.mockRejectedValue(new Error('transient network blip'));

    const mock = makeMockPrisma();
    mock.processingJobs.set('job-1', {
      id: 'job-1',
      tenantId: 'tenant-1',
      bookId: 'book-1',
      status: 'CREATED',
      correlationId: 'corr-1',
      startedAt: null,
    });
    mock.bookFiles.set('file-1', { id: 'file-1', storageKey: 'k', mimeType: 'application/pdf' });

    const storage = new InMemoryStorageProvider();
    await storage.put({ key: 'k', body: Buffer.from('%PDF-fake'), contentType: 'application/pdf' });

    await expect(
      processIngestionJob({
        prisma: mock.prisma as never,
        storage,
        logger,
        envelope: baseEnvelope,
        attemptsMade: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('transient network blip');

    expect(mock.outboxMessages).toHaveLength(0);
    const lastUpdate = mock.jobUpdates.at(-1)!;
    expect(lastUpdate.data).not.toMatchObject({ status: 'FAILED' });
  });
});
