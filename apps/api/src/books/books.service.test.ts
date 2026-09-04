import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InMemoryStorageProvider, checksumBuffer } from '@audio-book/storage';
import { NotFoundError } from '@audio-book/errors';
import { BooksService } from './books.service.js';
import type { UploadSessionRecord } from './upload-session.store.js';

const PDF_BUFFER = Buffer.from('%PDF-1.4 fake pdf content for tests');
const PDF_HASH = checksumBuffer(PDF_BUFFER).hash;

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [], scopes: [] };

function makeFakePrisma() {
  const books = new Map<string, Record<string, unknown>>();
  const bookFiles: Record<string, unknown>[] = [];
  const processingJobs: Record<string, unknown>[] = [];
  const outboxMessages: Record<string, unknown>[] = [];

  const tx = {
    bookFile: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        bookFiles.push(data);
        return Promise.resolve(data);
      }),
      findFirst: vi.fn(
        ({ where }: { where: { tenantId: string; contentHash: string; status: string } }) =>
          Promise.resolve(
            bookFiles.find(
              (f) =>
                f.tenantId === where.tenantId &&
                f.contentHash === where.contentHash &&
                f.status === where.status,
            ) ?? null,
          ),
      ),
    },
    processingJob: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        processingJobs.push(data);
        return Promise.resolve(data);
      }),
      findFirst: vi.fn(
        ({ where }: { where: { relatedResourceId: string; status: { in: string[] } } }) =>
          Promise.resolve(
            processingJobs.find(
              (j) =>
                j.relatedResourceId === where.relatedResourceId &&
                where.status.in.includes(j.status as string),
            ) ?? null,
          ),
      ),
      findUnique: vi.fn(),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = processingJobs.find((j) => j.id === where.id);
        if (job) Object.assign(job, data);
        return Promise.resolve(job);
      }),
      count: vi.fn(({ where }: { where: { bookId: string; status: { in: string[] } } }) =>
        Promise.resolve(
          processingJobs.filter(
            (j) => j.bookId === where.bookId && where.status.in.includes(j.status as string),
          ).length,
        ),
      ),
    },
    book: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = books.get(where.id) ?? {};
        books.set(where.id, { ...current, ...data });
        return Promise.resolve(books.get(where.id));
      }),
    },
    outboxMessage: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        outboxMessages.push(data);
        return Promise.resolve(data);
      }),
    },
  };

  const prisma = {
    book: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row = {
          ...data,
          currentBookVersionId: null,
          needsReview: false,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        books.set(data.id as string, row);
        return Promise.resolve(row);
      }),
      findFirst: vi.fn(({ where }: { where: { id: string; tenantId: string } }) => {
        const row = books.get(where.id);
        return Promise.resolve(row && row.tenantId === where.tenantId ? row : null);
      }),
      findMany: vi.fn(() => Promise.resolve([...books.values()])),
      update: tx.book.update,
    },
    bookFile: {
      findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        if ('id' in where) {
          return Promise.resolve(
            bookFiles.find((f) => f.id === where.id && f.bookId === where.bookId) ?? null,
          );
        }
        return tx.bookFile.findFirst({ where } as never);
      }),
    },
    processingJob: tx.processingJob,
    bookVersion: { findUnique: vi.fn(() => Promise.resolve(null)) },
    chapter: { count: vi.fn(() => Promise.resolve(0)) },
    paragraph: { count: vi.fn(() => Promise.resolve(0)) },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, books, bookFiles, processingJobs, outboxMessages };
}

function makeFakeUploadSessionStore() {
  const sessions = new Map<string, UploadSessionRecord>();
  return {
    create: vi.fn((record: UploadSessionRecord) => {
      sessions.set(record.id, record);
      return Promise.resolve();
    }),
    get: vi.fn((_tenantId: string, sessionId: string) =>
      Promise.resolve(sessions.get(sessionId) ?? null),
    ),
    update: vi.fn((record: UploadSessionRecord) => {
      sessions.set(record.id, record);
      return Promise.resolve();
    }),
    delete: vi.fn((_tenantId: string, sessionId: string) => {
      sessions.delete(sessionId);
      return Promise.resolve();
    }),
  };
}

function makeService() {
  const { prisma, books, bookFiles, processingJobs, outboxMessages } = makeFakePrisma();
  const storage = new InMemoryStorageProvider();
  const uploadSessions = makeFakeUploadSessionStore();
  const queueManager = {
    enqueue: vi.fn(
      (_queue: string, _envelope: { payload: { book_file_id: string } }, _opts?: unknown) =>
        Promise.resolve(),
    ),
  };
  const logger = { info: vi.fn() };

  // A tenant with no `tenant_quota` row is unlimited (see QuotaService), which
  // is what every fixture in this file models — so the stub asserts nothing and
  // simply lets creation through, exactly as the real service would.
  const quotas = {
    assertCanCreateBook: vi.fn(() => Promise.resolve()),
    recordUsage: vi.fn(() => Promise.resolve()),
  };

  const service = new BooksService(
    prisma as never,
    storage,
    queueManager as never,
    logger as never,
    uploadSessions as never,
    quotas as never,
  );

  return {
    service,
    prisma,
    quotas,
    storage,
    uploadSessions,
    queueManager,
    books,
    bookFiles,
    processingJobs,
    outboxMessages,
  };
}

describe('BooksService.createBook', () => {
  it('creates a book scoped to the caller tenant', async () => {
    const { service } = makeService();
    const book = await service.createBook(principal, { title: 'My Book', language: 'en' });
    expect(book.title).toBe('My Book');
    expect(book.tenant_id).toBe('tenant-1');
    expect(book.status).toBe('CREATED');
  });
});

describe('BooksService upload flow', () => {
  it('creates an upload session with a signed PUT url and mints a server-built storage key', async () => {
    const { service } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });

    const session = await service.createUploadSession(principal, book.id, {
      file_name: '../../etc/passwd.pdf', // hostile filename — must never influence the storage key
      declared_mime_type: 'application/pdf',
      declared_size_bytes: PDF_BUFFER.byteLength,
      declared_content_hash: { algorithm: 'SHA256', value: PDF_HASH },
      source_kind: 'PDF',
    });

    expect(session.status).toBe('AWAITING_UPLOAD');
    expect(session.upload_targets[0]!.method).toBe('PUT');
    expect(session.upload_targets[0]!.url).toContain('tenant-1/books/');
  });

  it('completes an upload session: admits the BookFile, enqueues parse_book, and emits book.uploaded', async () => {
    const { service, storage, queueManager, outboxMessages, bookFiles } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });
    const session = await service.createUploadSession(principal, book.id, {
      file_name: 'book.pdf',
      declared_mime_type: 'application/pdf',
      declared_size_bytes: PDF_BUFFER.byteLength,
      declared_content_hash: { algorithm: 'SHA256', value: PDF_HASH },
      source_kind: 'PDF',
    });
    // Simulate the client's PUT directly against object storage.
    await storage.put({
      key: `tenant-1/books/${book.id}/uploads/${session.id}/source.pdf`,
      body: PDF_BUFFER,
      contentType: 'application/pdf',
    });

    const result = await service.completeUploadSession(principal, book.id, session.id, {
      observed_size_bytes: PDF_BUFFER.byteLength,
    });

    expect(result.job.type).toBe('parse_book');
    expect(bookFiles).toHaveLength(1);
    expect(bookFiles[0]).toMatchObject({ status: 'ADMITTED', contentHash: PDF_HASH });
    const createdBookFileId = bookFiles[0]!.id as string;
    const call = queueManager.enqueue.mock.calls[0]!;
    expect(call[0]).toBe('parse');
    expect(call[1].payload.book_file_id).toBe(createdBookFileId);
    expect(outboxMessages.map((m) => m.eventType)).toEqual(['book.uploaded']);
  });

  it('records STORAGE_BYTES usage for the admitted file (Phase 10 quota completion)', async () => {
    const { service, storage, quotas } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });
    const session = await service.createUploadSession(principal, book.id, {
      file_name: 'book.pdf',
      declared_mime_type: 'application/pdf',
      declared_size_bytes: PDF_BUFFER.byteLength,
      declared_content_hash: { algorithm: 'SHA256', value: PDF_HASH },
      source_kind: 'PDF',
    });
    await storage.put({
      key: `tenant-1/books/${book.id}/uploads/${session.id}/source.pdf`,
      body: PDF_BUFFER,
      contentType: 'application/pdf',
    });

    await service.completeUploadSession(principal, book.id, session.id, {
      observed_size_bytes: PDF_BUFFER.byteLength,
    });

    expect(quotas.recordUsage).toHaveBeenCalledWith('tenant-1', 'STORAGE_BYTES', PDF_BUFFER.byteLength);
  });

  it('rejects completion when the uploaded content hash does not match the declared hash', async () => {
    const { service, storage } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });
    const session = await service.createUploadSession(principal, book.id, {
      file_name: 'book.pdf',
      declared_mime_type: 'application/pdf',
      declared_size_bytes: PDF_BUFFER.byteLength,
      declared_content_hash: { algorithm: 'SHA256', value: 'f'.repeat(64) }, // wrong hash
      source_kind: 'PDF',
    });
    await storage.put({
      key: `tenant-1/books/${book.id}/uploads/${session.id}/source.pdf`,
      body: PDF_BUFFER,
      contentType: 'application/pdf',
    });

    await expect(
      service.completeUploadSession(principal, book.id, session.id, {
        observed_size_bytes: PDF_BUFFER.byteLength,
      }),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  it('rejects completion with DUPLICATE_CONTENT_HASH when the same content was already admitted for this tenant', async () => {
    const { service, storage, bookFiles } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });

    bookFiles.push({
      id: 'existing-file',
      tenantId: 'tenant-1',
      bookId: book.id,
      contentHash: PDF_HASH,
      status: 'ADMITTED',
      deduplicatedFromBookFileId: null,
    });

    const session = await service.createUploadSession(principal, book.id, {
      file_name: 'book.pdf',
      declared_mime_type: 'application/pdf',
      declared_size_bytes: PDF_BUFFER.byteLength,
      declared_content_hash: { algorithm: 'SHA256', value: PDF_HASH },
      source_kind: 'PDF',
    });
    await storage.put({
      key: `tenant-1/books/${book.id}/uploads/${session.id}/source.pdf`,
      body: PDF_BUFFER,
      contentType: 'application/pdf',
    });

    await expect(
      service.completeUploadSession(principal, book.id, session.id, {
        observed_size_bytes: PDF_BUFFER.byteLength,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_CONTENT_HASH' });
  });
});

describe('BooksService.requestIngestion', () => {
  it('rejects when ingestion is already running for this book file, unless forced', async () => {
    const { service, prisma } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });
    const fakePrisma = prisma as unknown as {
      bookFile: { findFirst: ReturnType<typeof vi.fn> };
      processingJob: { create: (args: unknown) => Promise<unknown> };
    };
    fakePrisma.bookFile.findFirst = vi.fn(() =>
      Promise.resolve({ id: 'file-1', bookId: book.id, tenantId: 'tenant-1', status: 'ADMITTED' }),
    );
    await fakePrisma.processingJob.create({
      data: { relatedResourceType: 'book_file', relatedResourceId: 'file-1', status: 'RUNNING' },
    });

    await expect(
      service.requestIngestion(principal, book.id, { book_file_id: 'file-1' }),
    ).rejects.toMatchObject({ code: 'INGESTION_ALREADY_RUNNING' });
  });
});

const owner = { sub: 'owner-1', tenantId: 'tenant-1', roles: ['TENANT_OWNER'], scopes: [] };
const member = { sub: 'member-1', tenantId: 'tenant-1', roles: ['TENANT_MEMBER'], scopes: [] };

describe('BooksService.restoreBook (§16.6.2)', () => {
  it('clears deletedAt and never touches status', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);

    const { data } = await service.restoreBook(owner, book.id);
    expect(data.deleted_at).toBeNull();
    expect(data.status).toBe('CREATED');
  });

  it('rejects a non-owner with AuthorizationError, not silently allowing it', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);

    await expect(service.restoreBook(member, book.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('409s a book that is not deleted', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await expect(service.restoreBook(owner, book.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('BooksService.purgeBook (§16.6.3)', () => {
  it('enqueues a cleanup_artifacts job once preconditions are satisfied', async () => {
    const { service, queueManager, processingJobs } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);

    const result = await service.purgeBook(owner, book.id, { confirm_book_id: book.id });
    expect(result.job.type).toBe('cleanup_artifacts');
    expect(processingJobs.some((j) => j.type === 'cleanup_artifacts' && j.bookId === book.id)).toBe(
      true,
    );
    const call = queueManager.enqueue.mock.calls[0]!;
    expect(call[0]).toBe('maintenance');
  });

  it('rejects a confirm_book_id that does not match the path bookId', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);

    await expect(
      service.purgeBook(owner, book.id, { confirm_book_id: 'wrong-id' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('409s a book that has not been soft-deleted first', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await expect(
      service.purgeBook(owner, book.id, { confirm_book_id: book.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('refuses to purge while jobs are still active', async () => {
    const { service, prisma } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);
    await (prisma as unknown as { processingJob: { create: (a: unknown) => Promise<unknown> } }).processingJob.create(
      { data: { id: 'job-active', bookId: book.id, status: 'RUNNING' } },
    );

    await expect(
      service.purgeBook(owner, book.id, { confirm_book_id: book.id }),
    ).rejects.toMatchObject({ code: 'BOOK_HAS_ACTIVE_JOBS' });
  });

  it('rejects a non-owner even if the book is otherwise purge-eligible', async () => {
    const { service } = makeService();
    const book = await service.createBook(owner, { title: 'Book', language: 'en' });
    await service.deleteBook(owner, book.id);

    await expect(
      service.purgeBook(member, book.id, { confirm_book_id: book.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('BooksService tenant isolation', () => {
  it('returns NotFoundError (never AuthorizationError) for a book owned by a different tenant', async () => {
    const { service } = makeService();
    const book = await service.createBook(principal, { title: 'Book', language: 'en' });
    const otherPrincipal = { sub: 'user-2', tenantId: 'tenant-2', roles: [], scopes: [] };
    await expect(service.getBook(otherPrincipal, book.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
