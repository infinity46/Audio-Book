import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { GoneError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import { PRISMA } from '../tokens.js';

/**
 * `api-specification.md` §16.6.3: "After the job succeeds, every endpoint
 * for this `bookId` returns `410 RESOURCE_PURGED`." A purged book's row is
 * gone (§27.4's step 16), so a plain ownership lookup would otherwise 404 it
 * — indistinguishable from a `bookId` that never existed, which is the wrong
 * signal for a client that just watched its own purge job succeed.
 *
 * Deliberately a guard, not a change to `assertTenantOwnership` or to every
 * service's book-lookup query: `assertTenantOwnership` is called from seven
 * services (books, director, analysis, assembly, tts, voice, progress), and
 * threading a purge check through every one of those call sites would be a
 * much larger, more error-prone change for the same outcome. One guard, run
 * on every `:bookId`-scoped controller (placed after `JwtAuthGuard`/
 * `TenantRoleGuard` in each controller's guard list so authorization is
 * still checked first — a purged book's existence is not hidden from an
 * unauthenticated caller by anything else in this chain either, so ordering
 * here does not weaken authorization), checks the one thing that survives a
 * purge on purpose: the `audit_log: BOOK_PURGED` row (§27.4 step 17, "written,
 * never deleted"), via the existing `(resource_type, resource_id,
 * occurred_at)` index — no new table, no new column.
 */
@Injectable()
export class BookPurgeGuard implements CanActivate {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const bookId = (request.params as Record<string, string> | undefined)?.bookId;
    if (!bookId) return true;

    const purged = await this.prisma.auditLog.findFirst({
      where: { resourceType: 'book', resourceId: bookId, action: 'BOOK_PURGED' },
      select: { id: true },
    });
    if (purged) {
      throw new GoneError({
        code: 'RESOURCE_PURGED',
        message: 'This book was permanently deleted and can no longer be accessed.',
      });
    }
    return true;
  }
}
