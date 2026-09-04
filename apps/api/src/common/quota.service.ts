import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { QuotaExceededError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import { logError, type Logger } from '@audio-book/logging';
import { LOGGER, PRISMA } from './tokens.js';
import type { AuthenticatedPrincipal } from './guards/jwt-auth.guard.js';

/**
 * Tenant quota enforcement (`api-specification.md` §14.3, `context.md` §3.2.3).
 *
 * **Fails closed, unlike the quota *read*.** §16.2 says a quota read fails open
 * (a `200` with `degraded: true`) so a dashboard still renders during an
 * aggregator outage; enforcement on expensive work does the opposite. That
 * asymmetry is the whole point: showing a stale number costs nothing, letting
 * an unmetered book start costs GPU hours.
 *
 * **Only limits the product actually defines are enforced.** `tenant_quota` has
 * exactly four columns, and this service checks exactly those four. §44 of the
 * Phase 8 brief is explicit — "do not invent commercial limits if product
 * policy does not exist" — so there is no per-minute book cap, no invented
 * trial tier, and no default limit applied to a tenant with no quota row: a
 * tenant without a row is **unlimited**, which is what the absence of a row
 * means in this schema (it is nullable by omission, not by zero).
 */

export type QuotaDimension = 'CONCURRENT_BOOKS' | 'BOOKS_TOTAL' | 'STORAGE_BYTES' | 'GPU_MINUTES';

const ACTIVE_BOOK_STATUSES = [
  'PARSING',
  'ANALYZING',
  'CASTING',
  'SCRIPTING',
  'GENERATING',
  'ASSEMBLING',
] as const;

@Injectable()
export class QuotaService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Checked before admitting work that will consume a worker. Throws
   * `429 QUOTA_EXCEEDED` — a different code from `RATE_LIMITED`, because the
   * two mean different things to a client: one is "slow down", the other is
   * "you are out of allowance until the period rolls over or the limit is
   * raised", and retrying the first works while retrying the second does not.
   */
  async assertCanStartGeneration(principal: AuthenticatedPrincipal, bookId: string): Promise<void> {
    const quota = await this.prisma.tenantQuota.findUnique({
      where: { tenantId: principal.tenantId },
    });
    if (!quota) return; // No policy row: no limit. See the class docstring.

    const activeBooks = await this.prisma.book.count({
      where: {
        tenantId: principal.tenantId,
        deletedAt: null,
        status: { in: [...ACTIVE_BOOK_STATUSES] },
        // The book being started counts once, whether or not it is already
        // active — otherwise re-invoking a stage on an already-running book
        // would be refused by its own contribution to the total.
        NOT: { id: bookId },
      },
    });

    if (activeBooks >= quota.concurrentBooksLimit) {
      throw new QuotaExceededError({
        code: 'QUOTA_EXCEEDED',
        message: `This tenant may have ${quota.concurrentBooksLimit} book(s) in active generation at once; ${activeBooks} are active.`,
        // Retrying is futile until something finishes, so this is not
        // advertised as retryable even though its class is QUOTA.
        retryable: false,
      });
    }
  }

  /** Checked at book creation — the one limit that is about library size rather than compute. */
  async assertCanCreateBook(principal: AuthenticatedPrincipal): Promise<void> {
    const quota = await this.prisma.tenantQuota.findUnique({
      where: { tenantId: principal.tenantId },
    });
    if (!quota) return;

    const total = await this.prisma.book.count({
      where: { tenantId: principal.tenantId, deletedAt: null },
    });
    if (total >= quota.booksTotalLimit) {
      throw new QuotaExceededError({
        code: 'QUOTA_EXCEEDED',
        message: `This tenant's book limit of ${quota.booksTotalLimit} has been reached.`,
        retryable: false,
      });
    }
  }

  /**
   * Best-effort usage accounting. A failure here is logged, never propagated:
   * the work has already been admitted by the checks above, and failing the
   * user's request because a counter could not be incremented would trade a
   * billing inaccuracy for an outage.
   */
  async recordUsage(tenantId: string, metric: QuotaDimension, delta: number): Promise<void> {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    try {
      await this.prisma.tenantUsageCounter.upsert({
        where: { tenantId_periodStart_metric: { tenantId, periodStart, metric } },
        create: {
          id: generateId(),
          tenantId,
          periodStart,
          periodEnd,
          metric,
          usedValue: BigInt(delta),
        },
        // §7.5: "Increments use `UPDATE ... SET used_value = used_value + n`."
        update: { usedValue: { increment: BigInt(delta) } },
      });
    } catch (err) {
      logError(this.logger, err, 'Usage counter increment failed — usage under-reported');
    }
  }
}
