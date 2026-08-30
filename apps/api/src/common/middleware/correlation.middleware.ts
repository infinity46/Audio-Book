import { Injectable, type NestMiddleware } from '@nestjs/common';
import { generateId } from '@audio-book/events';
import { runWithCorrelation } from '@audio-book/logging';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Mints/echoes X-Request-Id and X-Trace-Id (api-specification.md §19's
 * correlation headers) and binds them into the AsyncLocalStorage-based
 * logging context for the lifetime of the request, so every log line
 * emitted while handling it — including from deep in a service call —
 * automatically carries correlation_id. Also passes through `traceparent`
 * (W3C trace context) unchanged if present.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    req: FastifyRequest['raw'] & { headers: Record<string, string | string[] | undefined> },
    res: FastifyReply['raw'],
    next: () => void,
  ): void {
    const headerRequestId = firstHeaderValue(req.headers['x-request-id']);
    const correlationId = headerRequestId ?? generateId();
    const traceId = firstHeaderValue(req.headers['x-trace-id']) ?? generateId();
    const traceparent = firstHeaderValue(req.headers['traceparent']);

    res.setHeader('X-Request-Id', correlationId);
    res.setHeader('X-Trace-Id', traceId);

    // Stash on the request for downstream access (exception filter, controllers)
    // without having to re-read headers.
    (
      req as unknown as {
        correlationContext: { correlationId: string; traceId: string; traceparent?: string };
      }
    ).correlationContext = { correlationId, traceId, traceparent };

    runWithCorrelation({ correlationId, causationId: traceparent }, () => next());
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
