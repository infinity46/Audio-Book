import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError } from '@audio-book/errors';
import { logError, type Logger } from '@audio-book/logging';
import { LOGGER, PRISMA } from '../common/tokens.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { AuditService } from '../common/audit.service.js';

export interface UpdateCurrentUserBody {
  display_name?: string;
  preferences?: { locale?: string; notification_email?: boolean };
}

/** `database-schema.md` §7.5 — the four metered dimensions. */
const QUOTA_METRICS = ['CONCURRENT_BOOKS', 'GPU_MINUTES', 'STORAGE_BYTES', 'BOOKS_TOTAL'] as const;

const METRIC_TO_FIELD = {
  CONCURRENT_BOOKS: 'concurrent_books',
  GPU_MINUTES: 'gpu_minutes_monthly',
  STORAGE_BYTES: 'storage_bytes',
  BOOKS_TOTAL: 'books_total',
} as const;

/**
 * The self-service user surface (`api-specification.md` §16.2).
 *
 * **Scope boundary.** This is *not* an authentication service — registration,
 * login, refresh, MFA, and password handling live in `../auth/auth.service.js`
 * (Phase 10). This service only reads/updates the already-authenticated
 * principal's own profile, quotas, and (as of Phase 10) session list, which
 * is why `GET/DELETE /users/me/sessions` below reads the `session`/
 * `refresh_token` tables `AuthService` writes rather than duplicating any
 * session-management logic.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  async getCurrentUser(principal: AuthenticatedPrincipal) {
    const user = await this.requireSelf(principal);
    return { data: toUserDto(user), etag: userEtag(user) };
  }

  /**
   * §16.2: `email` and `roles` are not patchable here — an email change is an
   * auth-domain operation and roles are administrative. They are absent from
   * the request schema, so an attempt is `422 unknown_field` at the pipe,
   * before this method runs.
   */
  async updateCurrentUser(
    principal: AuthenticatedPrincipal,
    body: UpdateCurrentUserBody,
    ifMatch?: string,
  ) {
    const user = await this.requireSelf(principal);
    assertIfMatch(ifMatch, userEtag(user));

    const preferences =
      body.preferences === undefined
        ? undefined
        : {
            ...(isRecord(user.preferences) ? user.preferences : {}),
            ...body.preferences,
          };

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: body.display_name,
        preferences,
        locale: body.preferences?.locale ?? undefined,
        rowVersion: { increment: 1 },
      },
    });
    return { data: toUserDto(updated), etag: userEtag(updated) };
  }

  /**
   * §16.2 quota read. **Fails open by design**: if the usage aggregator cannot
   * be read the response is still `200`, with `degraded: true` and `used`
   * values `null` (`context.md` §3.2.3). Quota *enforcement* on expensive work
   * fails closed and lives at job creation — see `QuotaService` — so a
   * degraded read here can never be used to sneak past a limit.
   */
  async getQuotas(principal: AuthenticatedPrincipal) {
    const period = currentPeriod();
    const [quota, counters] = await Promise.all([
      this.prisma.tenantQuota.findUnique({ where: { tenantId: principal.tenantId } }),
      this.prisma.tenantUsageCounter
        .findMany({
          where: { tenantId: principal.tenantId, periodStart: period.start },
        })
        .catch((err: unknown) => {
          logError(this.logger, err, 'Usage counter read failed — reporting degraded quotas');
          return null;
        }),
    ]);

    const usedByMetric = new Map<string, number>();
    for (const row of counters ?? []) usedByMetric.set(row.metric, Number(row.usedValue));

    const quotas: Record<string, { limit: number | null; used: number | null }> = {};
    for (const metric of QUOTA_METRICS) {
      quotas[METRIC_TO_FIELD[metric]] = {
        limit: quota ? limitFor(quota, metric) : null,
        used: counters === null ? null : (usedByMetric.get(metric) ?? 0),
      };
    }

    return {
      object: 'quota_summary' as const,
      tenant_id: principal.tenantId,
      degraded: counters === null,
      degraded_reasons: counters === null ? ['USAGE_AGGREGATOR_UNAVAILABLE'] : [],
      quotas,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
      links: { self: '/api/v1/users/me/quotas', user: '/api/v1/users/me' },
    };
  }

  /**
   * §16.2 — "Let a user see and revoke their active sessions." Only
   * non-revoked, non-expired sessions: a revoked/expired row is history, not
   * something the user needs to act on again.
   */
  async listSessions(principal: AuthenticatedPrincipal, currentSessionId: string | undefined) {
    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: { userId: principal.sub, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      object: 'session' as const,
      created_at: s.createdAt.toISOString(),
      last_seen_at: s.lastSeenAt?.toISOString() ?? null,
      user_agent_family: s.userAgentFamily,
      ip_country: s.ipCountry,
      current: s.id === currentSessionId,
    }));
  }

  /**
   * §16.2 — "a session belonging to another principal is 404" (existence-leak
   * rule, same asymmetry as cross-tenant book access). Naturally idempotent:
   * revoking an already-revoked/missing session is still `204`.
   */
  async revokeSession(principal: AuthenticatedPrincipal, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: principal.sub },
    });
    if (!session || session.revokedAt) return;

    const now = new Date();
    await withTransaction(this.prisma, async (tx) => {
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: now, revocationReason: 'USER_REVOKED' },
      });
      await tx.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    await this.audit.record({
      principal,
      action: 'SESSION_REVOKED',
      resourceType: 'user',
      resourceId: principal.sub,
      metadata: { session_id: sessionId, reason: 'USER_REVOKED' },
    });
  }

  private async requireSelf(principal: AuthenticatedPrincipal) {
    const user = await this.prisma.user.findFirst({
      where: { id: principal.sub, tenantId: principal.tenantId, deletedAt: null },
    });
    // A token whose `sub` has no row (deleted user, or a token minted for a
    // principal this deployment does not know) is 404 on self-read rather than
    // a 500 from a null dereference.
    if (!user) throw new NotFoundError({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    return user;
  }
}

export function limitFor(
  quota: {
    concurrentBooksLimit: number;
    gpuMinutesMonthlyLimit: number;
    storageBytesLimit: bigint;
    booksTotalLimit: number;
  },
  metric: (typeof QUOTA_METRICS)[number],
): number {
  switch (metric) {
    case 'CONCURRENT_BOOKS':
      return quota.concurrentBooksLimit;
    case 'GPU_MINUTES':
      return quota.gpuMinutesMonthlyLimit;
    case 'STORAGE_BYTES':
      return Number(quota.storageBytesLimit);
    case 'BOOKS_TOTAL':
      return quota.booksTotalLimit;
  }
}

/** Calendar-month periods, matching the `period_start`/`period_end` §16.2 illustrates. */
export function currentPeriod(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: string[];
  status: string;
  preferences: unknown;
  locale: string | null;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toUserDto(user: UserRow) {
  return {
    id: user.id,
    object: 'user' as const,
    email: user.email,
    display_name: user.displayName,
    tenant_id: user.tenantId,
    roles: user.roles,
    status: user.status,
    preferences: isRecord(user.preferences) ? user.preferences : {},
    locale: user.locale,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
    links: { self: '/api/v1/users/me', quotas: '/api/v1/users/me/quotas' },
  };
}

/**
 * ETags are derived from the row's `row_version`, not from the serialized
 * body: a body hash changes whenever this file's DTO shape changes, which
 * would invalidate every client's `If-Match` on deploy for no semantic reason.
 */
export function userEtag(user: { id: string; rowVersion: number }): string {
  return `"${createHash('sha256').update(`${user.id}:${user.rowVersion}`).digest('hex').slice(0, 32)}"`;
}

/**
 * §2.8: "When `If-Match` is present and stale, the response is
 * `409 RESOURCE_VERSION_CONFLICT`. When absent, last-write-wins applies to the
 * fields present in the patch body only."
 */
export function assertIfMatch(ifMatch: string | undefined, current: string): void {
  if (ifMatch === undefined) return;
  const candidates = ifMatch.split(',').map((v) => v.trim());
  if (candidates.includes('*') || candidates.includes(current)) return;
  throw new ConflictError({
    code: 'RESOURCE_VERSION_CONFLICT',
    message: 'The resource has changed since the version named in If-Match.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
