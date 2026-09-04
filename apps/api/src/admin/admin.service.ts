import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { NotFoundError, ValidationError } from '@audio-book/errors';
import { LOGGER, PRISMA } from '../common/tokens.js';
import type { Logger } from '@audio-book/logging';
import { decodeCursor, encodeCursor, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { AuditService, type CorrelationContext } from '../common/audit.service.js';
import { currentPeriod, limitFor } from '../users/users.service.js';

export interface UpdateTenantQuotasBody {
  concurrent_books?: number;
  gpu_minutes_monthly?: number;
  storage_bytes?: number;
  books_total?: number;
}

/**
 * The administrative surface (`api-specification.md` §16.22).
 *
 * **The content boundary is enforced in the shape of the data, not only by a
 * guard.** §16.22 permits "metadata, state, lineage, and diagnostics only —
 * never book text, Story Bible content, or audio bytes, and never a signed
 * URL". So the tenant detail endpoint returns book **counts** and never book
 * titles (the spec calls that out explicitly), no method here reads a
 * content-bearing table, and no method mints an access URL. An admin who
 * wanted a tenant's text would have to add an endpoint, not craft a request.
 *
 * Every read here is audited as `ADMIN_CROSS_TENANT_READ` (§14.12), because
 * the point of an administrative API is that it crosses the boundary the rest
 * of the system exists to hold.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  async listTenants(
    principal: AuthenticatedPrincipal,
    query: { cursor?: string; limit?: string; status?: string },
    correlation?: CorrelationContext,
  ) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.TenantWhereInput = { deletedAt: null };
    if (query.status) where.status = query.status as never;
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(String(cursor.v)) } },
        { AND: [{ createdAt: new Date(String(cursor.v)) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.tenant.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { _count: { select: { books: true, users: true } } },
    });

    await this.audit.record({
      principal,
      action: 'ADMIN_CROSS_TENANT_READ',
      resourceType: 'tenant',
      tenantId: undefined,
      correlation,
      metadata: { operation: 'list_tenants', returned: Math.min(rows.length, limit) },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map((t) => ({
        id: t.id,
        object: 'tenant' as const,
        name: t.name,
        status: t.status,
        plan_code: t.planCode,
        counts: { books: t._count.books, users: t._count.users },
        created_at: t.createdAt.toISOString(),
        updated_at: t.updatedAt.toISOString(),
        links: { self: `/api/v1/admin/tenants/${t.id}` },
      })),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  async getTenant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    correlation?: CorrelationContext,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { quota: true, _count: { select: { books: true, users: true } } },
    });
    if (!tenant) {
      throw new NotFoundError({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found.' });
    }

    const period = currentPeriod();
    const counters = await this.prisma.tenantUsageCounter.findMany({
      where: { tenantId, periodStart: period.start },
    });
    const used = new Map(counters.map((c) => [c.metric, Number(c.usedValue)]));

    await this.audit.record({
      principal,
      action: 'ADMIN_CROSS_TENANT_READ',
      resourceType: 'tenant',
      resourceId: tenantId,
      tenantId,
      correlation,
      metadata: { operation: 'get_tenant' },
    });

    return {
      id: tenant.id,
      object: 'tenant' as const,
      name: tenant.name,
      status: tenant.status,
      plan_code: tenant.planCode,
      // §16.22: "book titles are **not** returned".
      counts: { books: tenant._count.books, users: tenant._count.users },
      quotas: tenant.quota
        ? {
            concurrent_books: {
              limit: limitFor(tenant.quota, 'CONCURRENT_BOOKS'),
              used: used.get('CONCURRENT_BOOKS') ?? 0,
            },
            gpu_minutes_monthly: {
              limit: limitFor(tenant.quota, 'GPU_MINUTES'),
              used: used.get('GPU_MINUTES') ?? 0,
            },
            storage_bytes: {
              limit: limitFor(tenant.quota, 'STORAGE_BYTES'),
              used: used.get('STORAGE_BYTES') ?? 0,
            },
            books_total: {
              limit: limitFor(tenant.quota, 'BOOKS_TOTAL'),
              used: used.get('BOOKS_TOTAL') ?? 0,
            },
          }
        : null,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
      created_at: tenant.createdAt.toISOString(),
      updated_at: tenant.updatedAt.toISOString(),
      links: { self: `/api/v1/admin/tenants/${tenant.id}` },
    };
  }

  async updateTenantQuotas(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    body: UpdateTenantQuotasBody,
    correlation?: CorrelationContext,
  ) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundError({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found.' });
    }

    const data = {
      concurrentBooksLimit: body.concurrent_books,
      gpuMinutesMonthlyLimit: body.gpu_minutes_monthly,
      storageBytesLimit: body.storage_bytes === undefined ? undefined : BigInt(body.storage_bytes),
      booksTotalLimit: body.books_total,
      updatedByUserId: principal.sub,
    };

    // Upsert rather than update: a tenant with no quota row is *unlimited*
    // (see QuotaService), so the first time an operator sets a limit there is
    // nothing to update. `create` needs every column, so an incomplete first
    // write is refused rather than silently defaulted — a quota invented here
    // would be a commercial policy this code has no business inventing.
    const existing = await this.prisma.tenantQuota.findUnique({ where: { tenantId } });
    if (!existing) {
      const missing = (
        ['concurrent_books', 'gpu_minutes_monthly', 'storage_bytes', 'books_total'] as const
      ).filter((k) => body[k] === undefined);
      if (missing.length > 0) {
        throw new ValidationError({
          message:
            'This tenant has no quota row yet, so every limit must be supplied when creating one.',
          details: missing.map((field) => ({ field, issue: 'required' })),
        });
      }
    }

    const quota = existing
      ? await this.prisma.tenantQuota.update({ where: { tenantId }, data })
      : await this.prisma.tenantQuota.create({
          data: {
            tenantId,
            concurrentBooksLimit: body.concurrent_books!,
            gpuMinutesMonthlyLimit: body.gpu_minutes_monthly!,
            storageBytesLimit: BigInt(body.storage_bytes!),
            booksTotalLimit: body.books_total!,
            updatedByUserId: principal.sub,
          },
        });

    await this.audit.record({
      principal,
      action: 'QUOTA_CHANGED',
      resourceType: 'tenant',
      resourceId: tenantId,
      tenantId,
      correlation,
      metadata: {
        concurrent_books: quota.concurrentBooksLimit,
        gpu_minutes_monthly: quota.gpuMinutesMonthlyLimit,
        storage_bytes: Number(quota.storageBytesLimit),
        books_total: quota.booksTotalLimit,
      },
    });

    return {
      object: 'tenant_quota' as const,
      tenant_id: tenantId,
      concurrent_books: quota.concurrentBooksLimit,
      gpu_minutes_monthly: quota.gpuMinutesMonthlyLimit,
      storage_bytes: Number(quota.storageBytesLimit),
      books_total: quota.booksTotalLimit,
      updated_at: quota.updatedAt.toISOString(),
      links: { self: `/api/v1/admin/tenants/${tenantId}/quotas` },
    };
  }

  async listUsers(
    principal: AuthenticatedPrincipal,
    query: { cursor?: string; limit?: string; tenant_id?: string; email?: string },
    correlation?: CorrelationContext,
  ) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (query.tenant_id) where.tenantId = query.tenant_id;
    // Exact match only. A substring/`contains` search over an email column is
    // an unindexed scan of every user in the platform, which §55 of the
    // Phase 8 brief rules out ("no arbitrary query capabilities that can cause
    // expensive database scans").
    if (query.email) where.email = query.email;
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(String(cursor.v)) } },
        { AND: [{ createdAt: new Date(String(cursor.v)) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    await this.audit.record({
      principal,
      action: 'ADMIN_CROSS_TENANT_READ',
      resourceType: 'user',
      correlation,
      metadata: { operation: 'list_users', returned: Math.min(rows.length, limit) },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map((u) => ({
        id: u.id,
        object: 'user' as const,
        email: u.email,
        display_name: u.displayName,
        tenant_id: u.tenantId,
        roles: u.roles,
        status: u.status,
        last_login_at: u.lastLoginAt?.toISOString() ?? null,
        created_at: u.createdAt.toISOString(),
        updated_at: u.updatedAt.toISOString(),
      })),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  /**
   * §16.22: "DLQ contents with full error context ... nothing is silently
   * dropped, and DLQ entries are never auto-purged".
   *
   * Sourced from `processing_job` rows in `DEAD_LETTERED`, not from the Redis
   * DLQ list. The database is the authority on job state (`context.md`
   * §3.2.11 — "the queue is a cache of it"), it survives a broker flush, and
   * reading Redis here would put queue internals one serialization step away
   * from a public response.
   */
  async listDeadLetters(
    principal: AuthenticatedPrincipal,
    query: { cursor?: string; limit?: string; tenant_id?: string; type?: string },
    correlation?: CorrelationContext,
  ) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.ProcessingJobWhereInput = { status: 'DEAD_LETTERED' };
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.type) where.type = query.type as never;
    // Ordered and paged by `created_at`, not `completed_at`, to match the
    // existing partial index `processing_job_dead_lettered_idx (created_at)
    // WHERE status = 'DEAD_LETTERED'`. Ordering by `completed_at` would read
    // correctly and scan every dead-lettered row in the platform to do it.
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(String(cursor.v)) } },
        { AND: [{ createdAt: new Date(String(cursor.v)) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.processingJob.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    await this.audit.record({
      principal,
      action: 'ADMIN_CROSS_TENANT_READ',
      resourceType: 'job',
      correlation,
      metadata: { operation: 'list_dead_letters', returned: Math.min(rows.length, limit) },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map((j) => ({
        id: j.id,
        object: 'dead_letter' as const,
        job_id: j.id,
        tenant_id: j.tenantId,
        book_id: j.bookId,
        type: j.type,
        queue: j.queue,
        attempt_count: j.attemptCount,
        max_attempts: j.maxAttempts,
        error: {
          code: j.errorCode,
          class: j.errorClass,
          message: j.errorMessage,
          retryable: j.errorRetryable,
          terminal: j.errorTerminal,
        },
        correlation_id: j.correlationId,
        replayable: j.dispatchEnvelope !== null,
        dead_lettered_at: j.completedAt?.toISOString() ?? null,
        created_at: j.createdAt.toISOString(),
        links: { job: `/api/v1/jobs/${j.id}`, replay: `/api/v1/admin/jobs/${j.id}/replay` },
      })),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  /**
   * §16.22 worker fleet view — the one endpoint that is *allowed* to name
   * workers, and the reason it is administrative: §3 rule 3 forbids any public
   * endpoint naming a worker, host, or queue key, and this is not a public
   * endpoint.
   *
   * Today it returns whatever `worker` holds, which in this deployment is
   * nothing: no runtime registers itself (QA finding F-26, still open). The
   * endpoint exists rather than being omitted because an empty fleet view is
   * itself the operational signal that registration is not running — the
   * alternative, a missing endpoint, tells an operator nothing.
   */
  async listWorkers(principal: AuthenticatedPrincipal, correlation?: CorrelationContext) {
    const workers = await this.prisma.worker.findMany({
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 200,
    });

    await this.audit.record({
      principal,
      action: 'ADMIN_CROSS_TENANT_READ',
      resourceType: 'job',
      correlation,
      metadata: { operation: 'list_workers', returned: workers.length },
    });

    return {
      data: workers.map((w) => ({
        id: w.id,
        object: 'worker' as const,
        kind: w.kind,
        queues: w.queues,
        capabilities: w.capabilities,
        loaded_model_version_ids: w.loadedModelVersionIds,
        status: w.status,
        quarantine_reason: w.quarantineReason,
        last_heartbeat_at: w.lastHeartbeatAt?.toISOString() ?? null,
        service_version: w.serviceVersion,
        first_seen_at: w.firstSeenAt.toISOString(),
      })),
      page: { limit: 200, has_more: false, next_cursor: null, prev_cursor: null, total: null },
      registration_available: workers.length > 0,
    };
  }

  async listModelVersionsIncludingRetired() {
    const rows = await this.prisma.modelVersion.findMany({
      include: { modelRegistry: true },
      orderBy: [{ releasedAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return {
      data: rows.map((row) => ({
        id: row.id,
        object: 'model_version' as const,
        role: row.modelRegistry.role,
        provider_id: row.modelRegistry.providerId,
        model_id: row.modelRegistry.modelId,
        registry_status: row.modelRegistry.status,
        version: row.version,
        params_fingerprint: row.paramsFingerprint,
        released_at: row.releasedAt.toISOString(),
        deprecated_at: row.deprecatedAt?.toISOString() ?? null,
        quarantined_at: row.quarantinedAt?.toISOString() ?? null,
        quarantine_reason: row.quarantineReason,
      })),
      page: { limit: 200, has_more: false, next_cursor: null, prev_cursor: null, total: null },
    };
  }
}
