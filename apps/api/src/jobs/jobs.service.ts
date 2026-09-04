import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import {
  enqueueProcessingJob,
  isQueueName,
  QueueManager,
  RedisCancellationFlags,
  type QueueJobEnvelope,
} from '@audio-book/queue';
import type { Redis } from 'ioredis';
import { LOGGER, PRISMA, QUEUE_MANAGER, REDIS } from '../common/tokens.js';
import { decodeCursor, encodeCursor, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { AuditService, type CorrelationContext } from '../common/audit.service.js';

const PRODUCER = 'api';
const PRODUCER_VERSION = '1.0.0';

/** `api-specification.md` §20.2. Terminal jobs are no-ops for cancellation, never conflicts. */
const TERMINAL_JOB_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'] as const;
/** Cancellable immediately — the work has not started, so there is nothing to ask a worker to stop. */
const IMMEDIATELY_CANCELLABLE = ['CREATED', 'QUEUED', 'BLOCKED', 'RETRYING'] as const;

const JOB_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'BLOCKED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'DEAD_LETTERED',
] as const;

const JOB_TYPES = [
  'parse_book',
  'ocr_page',
  'normalize_text',
  'analyze_structure',
  'analyze_scene',
  'build_story_bible_delta',
  'generate_director_ir',
  'revise_director_ir',
  'generate_voice_preview',
  'generate_tts_chunk',
  'validate_audio',
  'process_audio',
  'verify_transcript',
  'assemble_chapter',
  'assemble_audiobook',
  'encode_delivery_format',
  'cleanup_artifacts',
] as const;

/** §16.18: "sort (allowlist created_at, completed_at; default created_at:desc)". */
const SORT_FIELDS = { created_at: 'createdAt', completed_at: 'completedAt' } as const;
type SortField = keyof typeof SORT_FIELDS;

export interface ListJobsQuery {
  book_id?: string;
  type?: string;
  status?: string;
  related_resource_id?: string;
  created_after?: string;
  created_before?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
}

export interface CancelJobBody {
  reason?: string;
}

export interface CancelJobOptions {
  /** `PLATFORM_ADMIN` may cancel any job (§16.18, §16.22) — the tenant scope check is then skipped and the call is audited as a cross-tenant action. */
  crossTenant?: boolean;
  correlation?: CorrelationContext;
}

/**
 * The public job surface (`api-specification.md` §16.18) and cooperative
 * cancellation (`event-contracts.md` §29).
 *
 * Two properties this service exists to protect:
 *
 * 1. **One job vocabulary.** The nine `ProcessingJob.status` values are
 *    reported verbatim; nothing here invents a second set of names, maps
 *    `RETRYING` onto `RUNNING` for tidiness, or reports a status the database
 *    does not hold (§20.2, `context.md` §25.8).
 * 2. **The response never claims work stopped.** Cancelling a `RUNNING` job
 *    sets the request flag and returns with `cancellation.effective = false`;
 *    only the worker's acknowledgement moves the job to `CANCELLED`. An API
 *    that reported "cancelled" the instant it was asked would be lying about
 *    a GPU that is still burning minutes.
 *
 * Worker identity is never exposed: `lease_worker_id`, hostnames, GPU serials
 * and Redis/queue keys stay internal (§14.11, §8.2). `worker_id` on an attempt
 * is the opaque internal id the spec explicitly permits, and nothing else.
 */
@Injectable()
export class JobsService {
  private readonly cancellationFlags: RedisCancellationFlags;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(REDIS) redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {
    this.cancellationFlags = new RedisCancellationFlags(redis);
  }

  // ------------------------------------------------------------------ reads --

  async listJobs(principal: AuthenticatedPrincipal, query: ListJobsQuery) {
    const limit = parseLimit(query.limit);
    const { field, direction } = parseSort(query.sort);
    const where = this.buildJobWhere({ tenantId: principal.tenantId }, query);

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      const boundary = cursorBoundary(field, cursor, direction);
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), boundary];
    }

    const rows = await this.prisma.processingJob.findMany({
      where,
      orderBy: [{ [SORT_FIELDS[field]]: direction }, { id: direction }],
      take: limit + 1,
    });

    return this.pageOfJobs(rows, limit, field);
  }

  /**
   * The cross-tenant admin listing (§16.22). Separated from `listJobs` rather
   * than parameterised with a `tenantId?` so that no code path can reach the
   * unscoped query by accident: the tenant filter in `listJobs` is not
   * optional, and this method's only caller is behind `PlatformAdminGuard`.
   */
  async listJobsAcrossTenants(query: ListJobsQuery & { tenant_id?: string; queue?: string }) {
    const limit = parseLimit(query.limit);
    const { field, direction } = parseSort(query.sort);
    const where = this.buildJobWhere({}, query);
    if (query.tenant_id) where.tenantId = query.tenant_id;
    if (query.queue) {
      if (!isQueueName(query.queue)) {
        throw new ValidationError({
          message: 'queue is not a known queue name.',
          details: [{ field: 'queue', issue: 'invalid_enum' }],
        });
      }
      where.queue = query.queue;
    }

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      const boundary = cursorBoundary(field, cursor, direction);
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), boundary];
    }

    const rows = await this.prisma.processingJob.findMany({
      where,
      orderBy: [{ [SORT_FIELDS[field]]: direction }, { id: direction }],
      take: limit + 1,
    });
    return this.pageOfJobs(rows, limit, field);
  }

  async getJob(principal: AuthenticatedPrincipal, jobId: string) {
    const job = await this.requireOwnedJob(principal, jobId);
    return toJobDto(job);
  }

  async listAttempts(
    principal: AuthenticatedPrincipal,
    jobId: string,
    query: { cursor?: string; limit?: string },
  ) {
    await this.requireOwnedJob(principal, jobId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const rows = await this.prisma.processingAttempt.findMany({
      where: {
        jobId,
        ...(cursor ? { attemptNumber: { gt: Number(cursor.v) } } : {}),
      },
      orderBy: { attemptNumber: 'asc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toAttemptDto),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.attemptNumber, last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  // ------------------------------------------------------------ cancellation --

  /**
   * `api-specification.md` §16.18 / `event-contracts.md` §29.2, implemented as
   * the state table says and idempotent in every case — a terminal job is a
   * `200` no-op, never a `409`, because cancelling something already finished
   * is not a conflict.
   */
  async cancelJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
    body: CancelJobBody,
    options: CancelJobOptions = {},
  ) {
    const job = options.crossTenant
      ? await this.requireAnyJob(jobId)
      : await this.requireOwnedJob(principal, jobId);

    if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) {
      // No-op, and deliberately not audited as a cancellation: nothing changed.
      return toJobDto(job);
    }

    const now = new Date();
    const immediate = (IMMEDIATELY_CANCELLABLE as readonly string[]).includes(job.status);

    // Children first, so a coordinator's cascade is committed with the parent's
    // own transition rather than in a second, separately-failable step (§29.4).
    const children = await this.prisma.processingJob.findMany({
      where: { parentJobId: jobId, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
      select: { id: true, status: true, queue: true, tenantId: true },
    });

    const cancelledImmediately: { id: string; queue: string; tenantId: string }[] = [];
    const requestedOnly: { id: string; tenantId: string }[] = [];

    await withTransaction(this.prisma, async (tx) => {
      for (const child of children) {
        const childImmediate = (IMMEDIATELY_CANCELLABLE as readonly string[]).includes(
          child.status,
        );
        await tx.processingJob.update({
          where: { id: child.id },
          data: cancellationPatch(principal.sub, now, childImmediate),
        });
        if (childImmediate) {
          cancelledImmediately.push({
            id: child.id,
            queue: child.queue,
            tenantId: child.tenantId,
          });
        } else {
          requestedOnly.push({ id: child.id, tenantId: child.tenantId });
        }
      }

      await tx.processingJob.update({
        where: { id: jobId },
        data: cancellationPatch(principal.sub, now, immediate),
      });
      if (immediate) {
        cancelledImmediately.push({ id: jobId, queue: job.queue, tenantId: job.tenantId });
      } else {
        requestedOnly.push({ id: jobId, tenantId: job.tenantId });
      }

      // `job.cancelled` fires only where cancellation has actually TAKEN
      // EFFECT (§12.8: "Cancellation takes effect"). A RUNNING job's event is
      // the worker's to emit when it acknowledges — emitting it here would
      // tell every consumer the work stopped while the GPU is still running.
      for (const cancelled of cancelledImmediately) {
        await writeOutboxMessage(tx, {
          eventType: 'job.cancelled',
          schemaVersion: 'events.v1',
          tenantId: cancelled.tenantId,
          bookId: job.bookId ?? undefined,
          jobId: cancelled.id,
          correlationId: job.correlationId,
          causationId: job.correlationId,
          producer: PRODUCER,
          producerVersion: PRODUCER_VERSION,
          aggregateType: 'job',
          aggregateId: cancelled.id,
          payload: {
            cancelled_by_user_id: principal.sub,
            cancellation_effective_at: now.toISOString(),
            partial_units_retained: true,
          },
        });
      }
    });

    // Everything below is best-effort cleanup of caches OUTSIDE the database.
    // The durable truth (`cancellation_requested`) is already committed, so a
    // Redis failure here delays cancellation, it does not lose it: a worker
    // that cannot read the flag falls back to the column
    // (`isCancellationRequested`).
    await Promise.all([
      ...cancelledImmediately.map(async ({ id, queue, tenantId }) => {
        if (isQueueName(queue)) {
          await this.queueManager.removeQueuedJob(queue, id).catch(() => false);
        }
        await this.cancellationFlags.set(tenantId, id).catch(() => undefined);
      }),
      ...requestedOnly.map(({ id, tenantId }) =>
        this.cancellationFlags.set(tenantId, id).catch(() => undefined),
      ),
    ]);

    await this.audit.record({
      principal,
      action: 'JOB_CANCELLED',
      resourceType: 'job',
      resourceId: jobId,
      bookId: job.bookId ?? undefined,
      tenantId: job.tenantId,
      correlation: options.correlation,
      metadata: {
        previous_status: job.status,
        effective: immediate,
        cascaded_child_count: children.length,
        cross_tenant: Boolean(options.crossTenant),
        // The reason is a user-authored string. It is stored, never echoed
        // into an error message or a log line (§12.6: user text is untrusted).
        has_reason: Boolean(body.reason),
      },
    });

    this.logger.info(
      {
        job_id: jobId,
        previous_status: job.status,
        effective: immediate,
        cascaded_child_count: children.length,
      },
      'Job cancellation requested',
    );

    const refreshed = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    return toJobDto(refreshed);
  }

  /**
   * Operator replay of a dead-lettered job (§16.22). Creates a **new** job
   * carrying the original's lineage and never mutates the original — a
   * replayed job that overwrote its predecessor would destroy the evidence of
   * why it was dead-lettered in the first place.
   */
  async replayJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
    correlation?: CorrelationContext,
  ) {
    const original = await this.requireAnyJob(jobId);

    if (original.status !== 'DEAD_LETTERED' && original.status !== 'FAILED') {
      throw new ConflictError({
        code: 'JOB_NOT_REPLAYABLE',
        message: `Only DEAD_LETTERED or FAILED jobs can be replayed; this job is ${original.status}.`,
      });
    }
    if (!original.dispatchEnvelope) {
      throw new ConflictError({
        code: 'JOB_NOT_REPLAYABLE',
        message:
          'This job has no recorded dispatch envelope, so it cannot be re-dispatched without inventing a payload.',
      });
    }
    if (!isQueueName(original.queue)) {
      throw new ConflictError({
        code: 'JOB_NOT_REPLAYABLE',
        message: 'This job targets a queue that no longer exists.',
      });
    }

    const newJobId = generateId();
    const now = new Date();
    // The original's recorded intent, with a fresh job id. `dispatch_envelope`
    // is JSONB, so it is already a JSON value — reusing it verbatim is what
    // makes a replay reproduce the original dispatch rather than a
    // reconstruction of it, and is the same guarantee `ProcessingJobSweeper`
    // relies on (QA finding F-4).
    const envelope: Prisma.JsonObject & QueueJobEnvelope<Prisma.JsonValue> = {
      ...(original.dispatchEnvelope as Prisma.JsonObject),
      job_id: newJobId,
    } as Prisma.JsonObject & QueueJobEnvelope<Prisma.JsonValue>;

    await this.prisma.processingJob.create({
      data: {
        id: newJobId,
        tenantId: original.tenantId,
        bookId: original.bookId,
        type: original.type,
        queue: original.queue,
        priority: original.priority,
        relatedResourceType: original.relatedResourceType,
        relatedResourceId: original.relatedResourceId,
        scope: original.scope ?? undefined,
        dispatchEnvelope: envelope,
        status: 'CREATED',
        statusChangedAt: now,
        maxAttempts: original.maxAttempts,
        // A replay is a NEW attempt at the same work: it must not inherit the
        // original's idempotency key, or the job system would treat it as the
        // same job and refuse it. The lineage link is `correlation_id`.
        idempotencyKey: `replay:${original.id}:${newJobId}`,
        idempotencyFingerprint: original.idempotencyFingerprint,
        correlationId: original.correlationId,
        causationId: original.id,
        forced: true,
        forcedByUserId: principal.sub,
        createdByUserId: principal.sub,
      },
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: newJobId,
      queue: original.queue,
      envelope,
      jobName: original.type,
      maxAttempts: original.maxAttempts,
    });

    await this.audit.record({
      principal,
      action: 'JOB_REPLAYED',
      resourceType: 'job',
      resourceId: newJobId,
      bookId: original.bookId ?? undefined,
      tenantId: original.tenantId,
      correlation,
      metadata: { replayed_from_job_id: original.id, original_status: original.status },
    });

    const created = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: newJobId } });
    return toJobDto(created);
  }

  // --------------------------------------------------------------- internals --

  private buildJobWhere(
    base: Prisma.ProcessingJobWhereInput,
    query: ListJobsQuery,
  ): Prisma.ProcessingJobWhereInput {
    const where: Prisma.ProcessingJobWhereInput = { ...base };
    if (query.book_id) where.bookId = query.book_id;
    if (query.related_resource_id) where.relatedResourceId = query.related_resource_id;

    const statuses = parseMulti(query.status, JOB_STATUSES, 'status');
    if (statuses.length > 0) where.status = { in: statuses as never };

    const types = parseMulti(query.type, JOB_TYPES, 'type');
    if (types.length > 0) where.type = { in: types as never };

    const createdAt: Prisma.DateTimeFilter = {};
    if (query.created_after) createdAt.gt = parseTimestamp(query.created_after, 'created_after');
    if (query.created_before) createdAt.lt = parseTimestamp(query.created_before, 'created_before');
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    return where;
  }

  private pageOfJobs(rows: JobRow[], limit: number, field: SortField) {
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toJobDto),
      page: {
        limit,
        has_more: hasMore,
        next_cursor:
          hasMore && last
            ? encodeCursor((last[SORT_FIELDS[field]] ?? new Date(0)).toISOString(), last.id)
            : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  /**
   * §16.18 authorization: "the job's recorded `tenant_id` is the check". A
   * cross-tenant id is `404`, never `403` — a `403` would confirm the job
   * exists somewhere (§6.4).
   */
  private async requireOwnedJob(principal: AuthenticatedPrincipal, jobId: string) {
    const job = await this.prisma.processingJob.findFirst({
      where: { id: jobId, tenantId: principal.tenantId },
    });
    if (!job) throw new NotFoundError({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    return job;
  }

  private async requireAnyJob(jobId: string) {
    const job = await this.prisma.processingJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    return job;
  }
}

function cancellationPatch(
  userId: string,
  now: Date,
  immediate: boolean,
): Prisma.ProcessingJobUpdateInput {
  const base = {
    cancellationRequested: true,
    cancellationRequestedAt: now,
    cancellationRequestedByUser: { connect: { id: userId } },
  };
  if (!immediate) return base;
  return {
    ...base,
    status: 'CANCELLED',
    statusChangedAt: now,
    completedAt: now,
    cancellationEffectiveAt: now,
  };
}

/** Keyset boundary for `(sortField, id)` in either direction, with `NULL`s excluded so the comparison is total. */
function cursorBoundary(
  field: SortField,
  cursor: { v: string | number; id: string },
  direction: 'asc' | 'desc',
): Prisma.ProcessingJobWhereInput {
  const column = SORT_FIELDS[field];
  const value = new Date(String(cursor.v));
  const strictly = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [
      { [column]: { [strictly]: value } },
      { AND: [{ [column]: value }, { id: { [strictly]: cursor.id } }] },
    ],
  };
}

function parseSort(raw: string | undefined): { field: SortField; direction: 'asc' | 'desc' } {
  if (!raw) return { field: 'created_at', direction: 'desc' };
  const [field, dir = 'desc'] = raw.split(':');
  if (!field || !(field in SORT_FIELDS) || (dir !== 'asc' && dir !== 'desc')) {
    throw new ValidationError({
      message: `sort must be one of ${Object.keys(SORT_FIELDS).join(', ')} with :asc or :desc.`,
      details: [{ field: 'sort', issue: 'invalid_enum' }],
    });
  }
  return { field: field as SortField, direction: dir };
}

/**
 * Multi-valued filters arrive as `?status=A&status=B` or `?status=A,B`. Values
 * are checked against the closed vocabulary rather than passed through: an
 * unchecked value would reach Postgres as an invalid enum literal and surface
 * as a 500 for what is a client mistake.
 */
function parseMulti(raw: string | undefined, allowed: readonly string[], field: string): string[] {
  if (!raw) return [];
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const invalid = values.filter((v) => !allowed.includes(v));
  if (invalid.length > 0) {
    throw new ValidationError({
      message: `${field} contains ${invalid.length} unrecognized value(s).`,
      details: [{ field, issue: 'invalid_enum' }],
    });
  }
  return values;
}

function parseTimestamp(raw: string, field: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError({
      message: `${field} must be an RFC 3339 timestamp.`,
      details: [{ field, issue: 'invalid_format' }],
    });
  }
  return date;
}

interface JobRow {
  id: string;
  tenantId: string;
  bookId: string | null;
  type: string;
  status: string;
  queue: string;
  priority: string;
  relatedResourceType: string;
  relatedResourceId: string;
  parentJobId: string | null;
  childJobCount: number;
  progress: number;
  progressStage: string | null;
  completedUnits: number;
  totalUnits: number | null;
  attemptCount: number;
  maxAttempts: number;
  retryCount: number;
  nextAttemptAt: Date | null;
  blockedReason: string | null;
  cancellationRequested: boolean;
  cancellationRequestedAt: Date | null;
  cancellationRequestedByUserId: string | null;
  cancellationEffectiveAt: Date | null;
  errorCode: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  errorTerminal: boolean | null;
  resultResourceType: string | null;
  resultResourceId: string | null;
  resultVersion: number | null;
  idempotencyFingerprint: string;
  forced: boolean;
  correlationId: string;
  createdAt: Date;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  heartbeatAt: Date | null;
}

/**
 * The contractual job resource of §16.18.
 *
 * Deliberately absent: `lease_worker_id`, `lease_expires_at`, `lease_fence`,
 * `dispatch_envelope`, and the raw `scope` payload. Those are internal
 * scheduling machinery; §3 rule 3 forbids any public endpoint naming a worker,
 * host, queue key, or storage bucket. `queue` is present because §16.18's own
 * example carries the *logical* queue label, which is a capacity concept a
 * client may legitimately see.
 */
function toJobDto(job: JobRow) {
  return {
    id: job.id,
    object: 'job' as const,
    type: job.type,
    status: job.status,
    tenant_id: job.tenantId,
    book_id: job.bookId,
    related_resource: { type: job.relatedResourceType, id: job.relatedResourceId },
    parent_job_id: job.parentJobId,
    child_job_count: job.childJobCount,
    priority: job.priority,
    queue: job.queue,
    progress: {
      value: job.progress,
      stage: job.progressStage,
      completed_units: job.completedUnits,
      // `null`, not `0`: "unknown total" and "no work to do" are different
      // facts, and §13 of the Phase 8 brief forbids reporting the first as
      // the second.
      total_units: job.totalUnits,
    },
    blocked_reason: job.blockedReason,
    attempt_count: job.attemptCount,
    max_attempts: job.maxAttempts,
    retry_count: job.retryCount,
    next_attempt_at: job.nextAttemptAt?.toISOString() ?? null,
    cancellation: {
      requested: job.cancellationRequested,
      requested_at: job.cancellationRequestedAt?.toISOString() ?? null,
      requested_by: job.cancellationRequestedByUserId,
      effective: job.cancellationEffectiveAt !== null,
    },
    error: job.errorCode
      ? {
          code: job.errorCode,
          class: job.errorClass,
          message: job.errorMessage,
          retryable: job.errorRetryable ?? false,
          terminal: job.errorTerminal ?? false,
          attempt_number: job.attemptCount,
        }
      : null,
    // §16.18: "`result` is null in every non-terminal state — the API never
    // predicts an outcome."
    result:
      job.status === 'SUCCEEDED' && job.resultResourceType && job.resultResourceId
        ? {
            type: job.resultResourceType,
            id: job.resultResourceId,
            version: job.resultVersion,
          }
        : null,
    idempotency_fingerprint: job.idempotencyFingerprint,
    forced: job.forced,
    correlation_id: job.correlationId,
    created_at: job.createdAt.toISOString(),
    queued_at: job.queuedAt?.toISOString() ?? null,
    started_at: job.startedAt?.toISOString() ?? null,
    completed_at: job.completedAt?.toISOString() ?? null,
    updated_at: job.updatedAt.toISOString(),
    heartbeat_at: job.heartbeatAt?.toISOString() ?? null,
    links: {
      self: `/api/v1/jobs/${job.id}`,
      attempts: `/api/v1/jobs/${job.id}/attempts`,
      cancellation: `/api/v1/jobs/${job.id}/cancellation`,
      events: `/api/v1/jobs/${job.id}/events`,
      book: job.bookId ? `/api/v1/books/${job.bookId}` : null,
    },
  };
}

interface AttemptRow {
  id: string;
  attemptNumber: number;
  status: string;
  workerId: string;
  leaseFence: bigint;
  modelVersions: unknown;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  errorCode: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  resourceUsage: unknown;
  outputResourceType: string | null;
  outputResourceId: string | null;
  createdAt: Date;
}

/**
 * §16.18: `worker_id` is an "opaque internal identifier". `worker_host_ref`,
 * `lease_fence`, `error_detail` and `diagnostic_storage_key` are NOT returned:
 * they name hosts, fencing tokens and storage keys respectively, all of which
 * §14.11 keeps out of public responses.
 */
function toAttemptDto(attempt: AttemptRow) {
  return {
    id: attempt.id,
    object: 'job_attempt' as const,
    attempt_number: attempt.attemptNumber,
    status: attempt.status,
    worker_id: attempt.workerId,
    started_at: attempt.startedAt.toISOString(),
    ended_at: attempt.endedAt?.toISOString() ?? null,
    duration_ms: attempt.durationMs,
    model_versions: attempt.modelVersions ?? [],
    error: attempt.errorCode
      ? { code: attempt.errorCode, class: attempt.errorClass, message: attempt.errorMessage }
      : null,
    resource_usage: attempt.resourceUsage ?? null,
    output_artifact:
      attempt.outputResourceType && attempt.outputResourceId
        ? { type: attempt.outputResourceType, id: attempt.outputResourceId }
        : null,
    created_at: attempt.createdAt.toISOString(),
    // ProcessingAttempt is immutable (`context.md` §4.5), so §7.1's
    // "immutable resources report updated_at == created_at" applies.
    updated_at: attempt.createdAt.toISOString(),
  };
}

export { toJobDto };
