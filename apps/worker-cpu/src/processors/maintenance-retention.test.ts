import { describe, expect, it, vi } from 'vitest';
import { runRetentionSweep } from './maintenance.js';

function makeStore() {
  const bookFiles = new Map<string, Record<string, unknown>>();
  const audioChunks = new Map<string, Record<string, unknown>>();
  const books = new Map<string, Record<string, unknown>>();

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const cond = condition as { in?: unknown[]; not?: unknown; lt?: Date };
        if (cond.in) return cond.in.includes(row[key]);
        if ('not' in cond) return row[key] !== cond.not;
        if (cond.lt) return (row[key] as Date).getTime() < cond.lt.getTime();
      }
      return row[key] === condition;
    });
  }

  const prisma = {
    bookFile: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve([...bookFiles.values()].filter((r) => matches(r, where))),
      ),
      updateMany: vi.fn(
        ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, row] of bookFiles) {
            if (where.id.in.includes(id)) {
              bookFiles.set(id, { ...row, ...data });
              count++;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
    audioChunk: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve([...audioChunks.values()].filter((r) => matches(r, where))),
      ),
      updateMany: vi.fn(
        ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, row] of audioChunks) {
            if (where.id.in.includes(id)) {
              audioChunks.set(id, { ...row, ...data });
              count++;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
    book: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve([...books.values()].filter((r) => matches(r, where))),
      ),
    },
  };

  return { prisma, bookFiles, audioChunks, books };
}

function makeStorage() {
  const deleted: string[] = [];
  return { storage: { delete: vi.fn((key: string) => (deleted.push(key), Promise.resolve())) }, deleted };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const CONFIG = { orphanArtifactTtlHours: 48, softDeleteDays: 30 };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('runRetentionSweep', () => {
  it('expires an orphaned (REJECTED) BookFile past the TTL, keeping the row', async () => {
    const { prisma, bookFiles } = makeStore();
    const { storage, deleted } = makeStorage();
    bookFiles.set('f1', {
      id: 'f1',
      storageKey: 'k1',
      status: 'REJECTED',
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 49 * HOUR),
    });

    const result = await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual(['k1']);
    expect(bookFiles.get('f1')).toMatchObject({ storageClass: 'EXPIRED' });
    expect(result.orphanedBookFilesExpired).toBe(1);
  });

  it('leaves a REJECTED BookFile inside the TTL window untouched', async () => {
    const { prisma, bookFiles } = makeStore();
    const { storage, deleted } = makeStorage();
    bookFiles.set('f1', {
      id: 'f1',
      storageKey: 'k1',
      status: 'REJECTED',
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 1 * HOUR), // well inside the 48h window
    });

    await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual([]);
    expect(bookFiles.get('f1')).toMatchObject({ storageClass: 'STANDARD' });
  });

  it('never touches an ADMITTED BookFile, however old', async () => {
    const { prisma, bookFiles } = makeStore();
    const { storage, deleted } = makeStorage();
    bookFiles.set('f1', {
      id: 'f1',
      storageKey: 'k1',
      status: 'ADMITTED',
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 365 * DAY),
    });

    await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual([]);
  });

  it('expires a superseded (isCurrent: false) AudioChunk for a COMPLETED book past the window', async () => {
    const { prisma, books, audioChunks } = makeStore();
    const { storage, deleted } = makeStorage();
    books.set('book-1', { id: 'book-1', status: 'COMPLETED', currentAudiobookId: 'ab-1', deletedAt: null });
    audioChunks.set('c1', {
      id: 'c1',
      bookId: 'book-1',
      storageKey: 'ck1',
      isCurrent: false,
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 31 * DAY),
    });

    const result = await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual(['ck1']);
    expect(audioChunks.get('c1')).toMatchObject({ storageClass: 'EXPIRED' });
    expect(result.supersededAudioChunksExpired).toBe(1);
  });

  it('never expires the CURRENT AudioChunk, even for a COMPLETED book past the window', async () => {
    const { prisma, books, audioChunks } = makeStore();
    const { storage, deleted } = makeStorage();
    books.set('book-1', { id: 'book-1', status: 'COMPLETED', currentAudiobookId: 'ab-1', deletedAt: null });
    audioChunks.set('c1', {
      id: 'c1',
      bookId: 'book-1',
      storageKey: 'ck1',
      isCurrent: true,
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 365 * DAY),
    });

    await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual([]);
  });

  it('never expires a superseded chunk while the book is still mid-pipeline (not COMPLETED)', async () => {
    const { prisma, books, audioChunks } = makeStore();
    const { storage, deleted } = makeStorage();
    books.set('book-1', { id: 'book-1', status: 'GENERATING', currentAudiobookId: null, deletedAt: null });
    audioChunks.set('c1', {
      id: 'c1',
      bookId: 'book-1',
      storageKey: 'ck1',
      isCurrent: false,
      storageClass: 'STANDARD',
      createdAt: new Date(Date.now() - 365 * DAY),
    });

    await runRetentionSweep(prisma as never, storage as never, logger as never, CONFIG);

    expect(deleted).toEqual([]);
  });
});
