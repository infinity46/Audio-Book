import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { httpStatusForError, isAppError, toErrorEnvelope, InternalError } from '@audio-book/errors';
import { logError, type Logger } from '@audio-book/logging';
import type { FastifyReply } from 'fastify';

/**
 * Single place every thrown error passes through on its way to an HTTP
 * response. Converts AppError instances (and, defensively, anything else)
 * into the exact envelope from api-specification.md §8.1, and never lets a
 * stack trace, exception name, or internal detail reach the client
 * (api-specification.md §8.2).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    // Read back the X-Request-Id/X-Trace-Id headers CorrelationMiddleware
    // already set on this response, rather than a property stashed on the
    // request object. CorrelationMiddleware runs as Fastify/middie
    // middleware and receives the RAW Node request; Nest's
    // ctx.getRequest() here returns the FastifyRequest *wrapper* — two
    // different objects, so anything stashed on one is invisible to the
    // other. Response headers are the one thing both sides actually share.
    const requestId = firstHeaderValue(response.getHeader('X-Request-Id')) ?? 'unknown';
    const traceId = firstHeaderValue(response.getHeader('X-Trace-Id')) ?? 'unknown';

    const normalized = normalizeException(exception);
    const status = httpStatusForError(normalized);
    const envelope = toErrorEnvelope(normalized, requestId, traceId);

    if (status >= 500) {
      logError(this.logger, normalized, 'Unhandled error while processing request');
    }

    void response.status(status).send(envelope);
  }
}

/** NestJS built-in HttpException instances are mapped to InternalError rather than leaking Nest's own shape. */
function normalizeException(exception: unknown): unknown {
  if (isAppError(exception)) return exception;
  if (exception instanceof HttpException) {
    return new InternalError({ message: 'Request could not be processed.', cause: exception });
  }
  return exception;
}

function firstHeaderValue(value: number | string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'number') return String(value);
  return value;
}
