import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';
import {
  AuditService,
  correlationFromReply,
  type AuditActionName,
  type AuditResourceType,
} from '../audit.service.js';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
  // Fastify types `params` as `unknown` on the generic request; every route
  // here declares its parameters as strings, so narrowing is safe and keeps
  // the read below from needing a cast at each use.
  params: Record<string, string | undefined>;
}

/**
 * Records the user actions `api-specification.md` §14.12 requires an audit
 * trail for, without scattering audit calls through every service.
 *
 * **Only successful actions are recorded**, because that is what the audit
 * question is: "who did this to this book". A rejected request changed
 * nothing, and recording rejections here would bury the real actions under
 * every validation typo. Authentication and authorization failures are a
 * different concern with a different retention profile, and are already
 * logged by the guards that raise them.
 *
 * **The route table is explicit and closed.** An action is audited only if it
 * appears below, so adding a route does not silently start (or stop) auditing
 * it — the decision is visible in one place, in the vocabulary of the
 * `AuditAction` enum rather than a free-text string.
 */
interface AuditRule {
  method: string;
  /** Matched against the path with `:param` segments treated as wildcards. */
  pattern: RegExp;
  action: AuditActionName;
  resourceType: AuditResourceType;
}

const AUDIT_RULES: AuditRule[] = [
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books$/,
    action: 'BOOK_CREATED',
    resourceType: 'book',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v1\/books\/[^/]+$/,
    action: 'BOOK_DELETED',
    resourceType: 'book',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/restoration$/,
    action: 'BOOK_RESTORED',
    resourceType: 'book',
  },
  // Deliberately NOT `POST .../purge` -> `BOOK_PURGED` here: that action
  // means "the purge completed" (`database-schema.md` §27.4 step 17), and
  // `BookPurgeGuard` treats its presence as proof the book is gone. Auditing
  // it at *request* time — before the async cleanup_artifacts job has done
  // anything — would make every subsequent read of the book 410 while the
  // book and its artifacts still fully exist. The worker writes this row
  // once, correctly, as the last step of the purge it actually performed.
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/upload-sessions\/[^/]+\/completion$/,
    action: 'UPLOAD_FINALIZED',
    resourceType: 'book_file',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/director$/,
    action: 'DIRECTOR_REGENERATION_REQUESTED',
    resourceType: 'book',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/director\/revisions$/,
    action: 'DIRECTOR_REGENERATION_REQUESTED',
    resourceType: 'book',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/tts$/,
    action: 'TTS_REGENERATION_REQUESTED',
    resourceType: 'book',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/books\/[^/]+\/assembly$/,
    action: 'ASSEMBLY_REQUESTED',
    resourceType: 'book',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v1\/books\/[^/]+\/characters\/[^/]+\/voice$/,
    action: 'VOICE_ASSIGNED',
    resourceType: 'book',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/.*\/access-urls$/,
    action: 'ACCESS_URL_MINTED',
    resourceType: 'book',
  },
];

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithPrincipal>();
    const reply = http.getResponse<FastifyReply>();

    const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
    const rule = AUDIT_RULES.find(
      (r) => r.method === request.method.toUpperCase() && r.pattern.test(path),
    );
    if (!rule) return next.handle();

    return next.handle().pipe(
      tap((body: unknown) => {
        const principal = request.principal;
        if (!principal) return;
        const bookId = request.params?.bookId;
        void this.audit.record({
          principal,
          action: rule.action,
          resourceType: rule.resourceType,
          // For a create, the id is only knowable from the response body; for
          // everything else it is the path parameter.
          resourceId: bookId ?? extractCreatedId(body),
          bookId,
          correlation: correlationFromReply(reply),
          metadata: { method: request.method.toUpperCase(), route: rule.pattern.source },
        });
      }),
    );
  }
}

/** Reads `data.id` (single resource) or `data.job.id` (async operation, §7.3). */
function extractCreatedId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const id = (data as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  const job = (data as { job?: { id?: unknown } }).job;
  if (job && typeof job.id === 'string') return job.id;
  return undefined;
}
