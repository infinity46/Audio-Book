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

  const service = new BooksService(
    prisma as never,
    storage,
    queueManager as never,
    logger as never,
    uploadSessions as never,
  );

  return {
    service,
    prisma,
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
