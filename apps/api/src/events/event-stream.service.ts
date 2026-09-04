import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { QuotaExceededError } from '@audio-book/errors';
import type { Logger } from '@audio-book/logging';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EVENT_STREAM_CONFIG, LOGGER, PRISMA } from '../common/tokens.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';

/**
 * Server-Sent Events for book and job progress (`api-specification.md` §16.19).
 *
 * **Why the outbox is the source.** §16.19 is explicit that the stream is "a
 * notification channel, not a source of truth", that it carries "persisted
 * state changes", and that it must not become a second state source. The
 * `outbox_message` table already *is* the durable, ordered, tenant-scoped
 * record of every domain fact this system produces (`event-contracts.md` §19),
 * so tailing it gives live delivery, `Last-Event-ID` resumption, and the
 * event-name vocabulary of §12 for free — without inventing a parallel
 * in-memory bus that could disagree with the database.
 *
 * The cost is poll latency rather than push latency. That is a deliberate
 * trade: §16.19 states "HTTP polling is the baseline and is always
 * sufficient"; SSE exists to spare the *client* a fast poll, and a
 * sub-second server-side tail achieves that. A Redis pub/sub fan-out would cut
 * the latency further and is an additive change (a different transport behind
 * the same endpoint), not a contract change.
 *
 * **What is never streamed.** Payloads carry identifiers and small facts only:
 * no text, no audio, no signed URL (§11.3 payload rule). This service does not
 * construct payloads — it forwards what the producing transaction committed —
 * so the guarantee is upheld at the producer, and re-checked here by refusing
 * to widen the event set beyond the book-scoped subset §16.19 names.
 */

export interface StreamScope {
  scope: 'book' | 'job';
  id: string;
  principal: AuthenticatedPrincipal;
}

/**
 * §16.19: "Public streams carry the book-scoped subset: `book.*`,
 * `character.*`, `voice.*`, `director.*`, `tts.*`, `audio.*`, `chapter.*`,
 * `audiobook.*`, and `job.*` for jobs the caller owns."
 */
const PUBLIC_EVENT_PREFIXES = [
  'book.',
  'character.',
  'voice.',
  'director.',
  'tts.',
  'audio.',
  'chapter.',
  'audiobook.',
  'job.',
];

export interface EventStreamConfig {
  /** How often the tail is polled. */
  pollIntervalMs: number;
  /** Comment frames that keep proxies from closing an idle connection. */
  keepAliveMs: number;
  /** The server closes the stream after this, and expects the client to reconnect (§16.19). */
  maxConnectionMs: number;
  /** `Last-Event-ID` older than this is outside the replay window -> `stream.resync`. */
  replayWindowMs: number;
  /** Frames per poll, so one slow consumer cannot be handed an unbounded batch. */
  batchSize: number;
  /** Concurrent streams per principal; exceeding is a `429` (§16.19). */
  maxStreamsPerPrincipal: number;
}

export const DEFAULT_EVENT_STREAM_CONFIG: EventStreamConfig = {
  pollIntervalMs: 1000,
  keepAliveMs: 15_000,
  maxConnectionMs: 30 * 60_000,
  replayWindowMs: 60 * 60_000,
  batchSize: 100,
  maxStreamsPerPrincipal: 4,
};

/** Keyset position in the outbox tail. `eventId` is null until an event anchors it. */
interface StreamCursor {
  createdAt: Date;
  eventId: string | null;
}

interface OutboxTailRow {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  occurredAt: Date;
  bookId: string | null;
  jobId: string | null;
  correlationId: string;
  payload: unknown;
  createdAt: Date;
}

@Injectable()
export class EventStreamService {
  /**
   * Per-principal connection counter. Deliberately process-local: it bounds
   * what THIS instance will hold open, which is the resource actually being
   * protected (file descriptors and database poll load on this box). A
   * cluster-wide limit would need Redis and would still not stop a client
   * spreading connections across instances behind a load balancer — the
   * per-instance bound is the honest one, and the rate limiter already caps
   * connection *attempts*.
   */
  private readonly openStreams = new Map<string, number>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    // Injected by token rather than defaulted in the signature: Nest resolves
    // constructor parameters from `design:paramtypes` and does not see
    // TypeScript default values, so a defaulted parameter is a missing
    // provider at boot, not a fallback.
    @Inject(EVENT_STREAM_CONFIG) private readonly config: EventStreamConfig,
  ) {}

  async open(reply: FastifyReply, request: FastifyRequest, scope: StreamScope): Promise<void> {
    const principalKey = `${scope.principal.tenantId}:${scope.principal.sub}`;
    const current = this.openStreams.get(principalKey) ?? 0;
    if (current >= this.config.maxStreamsPerPrincipal) {
      throw new QuotaExceededError({
        code: 'RATE_LIMITED',
        message: `At most ${this.config.maxStreamsPerPrincipal} concurrent event streams per principal.`,
      });
    }
    this.openStreams.set(principalKey, current + 1);

    const lastEventId = headerValue(request.headers['last-event-id']);

    // Take the response away from Fastify before touching the raw socket.
    //
    // Without `hijack()`, Fastify still owns the reply lifecycle: when the
    // controller's promise resolves it serializes and sends a response of its
    // own, and this app's `onSend` hook (main.ts, the default `Cache-Control:
    // no-store`) runs too. Both act on a response that has already had headers
    // and a frame written to it directly, and the result is that the stream is
    // closed immediately after the opening comment — the client sees
    // `: stream open` and then end-of-stream, which is indistinguishable from
    // a pipeline that produced no events. `hijack()` is Fastify's documented
    // way to say "I am managing this socket now".
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Defeats proxy buffering, which otherwise holds frames until a buffer
      // fills and makes a "live" stream arrive in minute-long bursts.
      'X-Accel-Buffering': 'no',
    });
    raw.write(': stream open\n\n');

    let cursor: StreamCursor = await this.resolveStartCursor(lastEventId, raw);
    let closed = false;
    const timers: ReturnType<typeof setInterval>[] = [];

    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      const remaining = (this.openStreams.get(principalKey) ?? 1) - 1;
      if (remaining <= 0) this.openStreams.delete(principalKey);
      else this.openStreams.set(principalKey, remaining);
      raw.end();
    };

    const pollTimer = setInterval(() => {
      void (async () => {
        if (closed) return;
        try {
          const rows = await this.readTail(scope, cursor);
          for (const row of rows) {
            if (!isPublicEvent(row.eventType)) continue;
            raw.write(frame(row));
          }
          const last = rows.at(-1);
          if (last) cursor = { createdAt: last.createdAt, eventId: last.eventId };
        } catch (err) {
          // A failed poll must not kill the stream: the next tick retries, and
          // the client's own reconnect is the backstop. Losing frames costs a
          // stale UI for one interval, never correctness — the contract already
          // says clients re-read `.../progress` as the source of truth.
          this.logger.warn(
            { scope: scope.scope, err: String(err) },
            'Event stream tail poll failed; continuing',
          );
        }
      })();
    }, this.config.pollIntervalMs);

    const keepAliveTimer = setInterval(() => {
      if (!closed) raw.write(': keep-alive\n\n');
    }, this.config.keepAliveMs);

    const lifetimeTimer = setTimeout(close, this.config.maxConnectionMs);
    timers.push(pollTimer, keepAliveTimer, lifetimeTimer);

    // Teardown listens on the RESPONSE, not the request.
    //
    // `IncomingMessage` emits `close` once the request message is complete —
    // and a `GET` has no body, so that fires almost immediately. Listening
    // there tore every stream down within milliseconds of opening it: the
    // client received the `: stream open` comment and then nothing, forever,
    // which looks exactly like a pipeline that produced no events.
    // `ServerResponse` emits `close` when the response finishes or the
    // connection is destroyed, which is the signal actually wanted here.
    raw.on('close', close);
    raw.on('error', close);
  }

  /**
   * Resolves `Last-Event-ID` to a keyset position, or tells the client to
   * resync. §16.19: "If the requested id is outside the window, the server
   * sends a `stream.resync` control event instructing the client to re-read
   * `GET .../progress`."
   */
  private async resolveStartCursor(
    lastEventId: string | undefined,
    raw: { write(chunk: string): unknown },
  ): Promise<StreamCursor> {
    // The database's clock, not this process's.
    //
    // `outbox_message.created_at` is filled by Postgres (`@default(now())`),
    // so a cursor taken from `new Date()` is compared against timestamps from
    // a different clock. A few milliseconds of skew — measured at ~2ms between
    // this API and its Postgres, with the API *ahead* — is enough for an event
    // written immediately after the stream opens to land behind the cursor and
    // never be delivered. That failure is silent, intermittent, and looks
    // exactly like "the pipeline produced nothing", which is why the extra
    // round-trip is worth it.
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const now = rows[0]?.now ?? new Date();
    // `eventId: null` means "start after this instant, with no tie to break".
    // An empty-string sentinel here is not merely ugly: `event_id` is a
    // `uuid` column, and Prisma refuses to coerce `''` to one — every poll
    // failed with "Error creating UUID, invalid length" and the stream
    // silently delivered nothing.
    if (!lastEventId) return { createdAt: now, eventId: null };

    const anchor = await this.prisma.outboxMessage.findUnique({
      where: { eventId: lastEventId },
      select: { eventId: true, createdAt: true },
    });

    const windowStart = new Date(now.getTime() - this.config.replayWindowMs);
    if (!anchor || anchor.createdAt < windowStart) {
      raw.write(
        `event: stream.resync\ndata: ${JSON.stringify({
          reason: anchor ? 'OUTSIDE_REPLAY_WINDOW' : 'UNKNOWN_EVENT_ID',
          action: 'RE_READ_PROGRESS',
        })}\n\n`,
      );
      return { createdAt: now, eventId: null };
    }
    return { createdAt: anchor.createdAt, eventId: anchor.eventId };
  }

  /**
   * Tenant scoping is applied to the query itself, not to the rows afterwards:
   * a filter that runs after the read is one refactor away from being dropped,
   * and this endpoint streams another tenant's facts if it is.
   */
  private async readTail(scope: StreamScope, cursor: StreamCursor): Promise<OutboxTailRow[]> {
    return this.prisma.outboxMessage.findMany({
      where: {
        tenantId: scope.principal.tenantId,
        ...(scope.scope === 'book' ? { bookId: scope.id } : { jobId: scope.id }),
        // The tie-break on `event_id` only applies once there IS an anchor
        // event to tie against; before that the cursor is a bare instant.
        ...(cursor.eventId === null
          ? { createdAt: { gt: cursor.createdAt } }
          : {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                {
                  AND: [{ createdAt: cursor.createdAt }, { eventId: { gt: cursor.eventId } }],
                },
              ],
            }),
      },
      orderBy: [{ createdAt: 'asc' }, { eventId: 'asc' }],
      take: this.config.batchSize,
      select: {
        eventId: true,
        eventType: true,
        schemaVersion: true,
        occurredAt: true,
        bookId: true,
        jobId: true,
        correlationId: true,
        payload: true,
        createdAt: true,
      },
    });
  }
}

function isPublicEvent(eventType: string): boolean {
  return PUBLIC_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

function frame(row: OutboxTailRow): string {
  const data = {
    schema_version: row.schemaVersion,
    event_type: row.eventType,
    occurred_at: row.occurredAt.toISOString(),
    book_id: row.bookId,
    job_id: row.jobId,
    correlation_id: row.correlationId,
    payload: row.payload,
  };
  return `id: ${row.eventId}\nevent: ${row.eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
