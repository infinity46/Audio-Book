import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import {
  httpStatusForError,
  isAppError,
  toErrorEnvelope,
  InternalError,
  MalformedRequestError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '@audio-book/errors';
import { logError, type Logger } from '@audio-book/logging';
import type { FastifyReply } from 'fastify';
import { normalizePrismaError } from '../prisma-error.js';

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

/**
 * NestJS built-in `HttpException`s are translated into this API's own error
 * taxonomy rather than leaking Nest's shape.
 *
 * The framework raises these before any controller runs — an unrouted path, an
 * unsupported method, a body over the limit — and they are genuine client
 * errors with correct statuses of their own. Collapsing all of them to `500`
 * (as this filter previously did) told a caller who mistyped a URL that the
 * server was broken, and put a client mistake in the server-error logs where
 * it would be triaged as an incident. §117 of the Phase 8 brief asks that
 * every failure produce a meaningful user-facing state; a `404` typed as a
 * `500` is the opposite.
 *
 * Anything outside this table still collapses to `INTERNAL_ERROR`: a status
 * this API did not deliberately choose is not one it should be asserting.
 */
function normalizeException(exception: unknown): unknown {
  if (isAppError(exception)) return exception;
  // A malformed identifier is a client mistake, not a server fault — see
  // `prisma-error.ts` for why this belongs at the boundary rather than in
  // every service.
  const fromPrisma = normalizePrismaError(exception);
  if (isAppError(fromPrisma)) return fromPrisma;
  if (exception instanceof HttpException) {
    switch (exception.getStatus()) {
      case 404:
        return new NotFoundError({
          code: 'RESOURCE_NOT_FOUND',
          message: 'No such resource.',
          cause: exception,
        });
      case 405:
        return new MethodNotAllowedError({
          message: 'That method is not supported for this resource.',
          cause: exception,
        });
      case 400:
        return new MalformedRequestError({
          message: 'The request could not be parsed.',
          cause: exception,
        });
      case 413:
        return new PayloadTooLargeError({
          cause: exception,
          message: 'Request payload too large.',
        });
      case 415:
        return new UnsupportedMediaTypeError({
          cause: exception,
          message: 'Unsupported media type.',
        });
      default:
        return new InternalError({ message: 'Request could not be processed.', cause: exception });
    }
  }
  return exception;
}

function firstHeaderValue(value: number | string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'number') return String(value);
  return value;
}
