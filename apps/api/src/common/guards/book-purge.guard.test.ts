import { describe, expect, it, vi } from 'vitest';
import { BookPurgeGuard } from './book-purge.guard.js';

function makeContext(params: Record<string, string>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  } as never;
}

describe('BookPurgeGuard', () => {
  it('passes through routes with no bookId param', async () => {
    const prisma = { auditLog: { findFirst: vi.fn() } };
    const guard = new BookPurgeGuard(prisma as never);
    await expect(guard.canActivate(makeContext({}))).resolves.toBe(true);
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it('passes through a bookId with no BOOK_PURGED audit row', async () => {
    const prisma = { auditLog: { findFirst: vi.fn(() => Promise.resolve(null)) } };
    const guard = new BookPurgeGuard(prisma as never);
    await expect(guard.canActivate(makeContext({ bookId: 'book-1' }))).resolves.toBe(true);
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: { resourceType: 'book', resourceId: 'book-1', action: 'BOOK_PURGED' },
      select: { id: true },
    });
  });

  it('refuses with 410 RESOURCE_PURGED when a BOOK_PURGED audit row exists', async () => {
    const prisma = { auditLog: { findFirst: vi.fn(() => Promise.resolve({ id: 'audit-1' })) } };
    const guard = new BookPurgeGuard(prisma as never);
    await expect(guard.canActivate(makeContext({ bookId: 'book-1' }))).rejects.toMatchObject({
      code: 'RESOURCE_PURGED',
      httpStatus: 410,
    });
  });
});
