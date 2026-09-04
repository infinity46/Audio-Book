import { AppError, NotFoundError, ValidationError } from '@audio-book/errors';

/**
 * Translates the Prisma errors that are really *client* mistakes into this
 * API's own taxonomy, so they surface as 4xx rather than 500.
 *
 * **Why this exists.** `GET /api/v1/jobs/not-a-uuid` used to return
 * `500 INTERNAL_ERROR`. Prisma refuses to coerce a non-UUID string for a
 * `@db.Uuid` column and raises `P2023`, which escaped as an unhandled error.
 * Nothing was wrong with the server: the caller sent a malformed identifier,
 * and §9.1 has a status for that. A 500 here is worse than cosmetic — it tells
 * the client to retry something that can never succeed, and it puts client
 * typos in the server-error logs where they are triaged as incidents.
 *
 * This is the same class as QA finding F-17 ("a missing optional field yields
 * 500, not 422"): the API accepts a request the database then rejects. Fixing
 * it centrally means a new endpoint inherits the correct behaviour instead of
 * needing to remember a guard.
 *
 * The mapping is deliberately narrow. Only codes whose meaning is unambiguously
 * "the request was wrong" are translated; anything else stays a 500, because a
 * status this API did not deliberately choose is not one it should assert.
 */

interface PrismaKnownError {
  code: string;
  meta?: Record<string, unknown>;
}

function isPrismaKnownError(err: unknown): err is PrismaKnownError {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const { code } = err;
  return typeof code === 'string' && /^P\d{4}$/.test(code);
}

export function normalizePrismaError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (!isPrismaKnownError(err)) return err;

  switch (err.code) {
    // P2023 — "Inconsistent column data", raised when a value cannot be
    // coerced to its column type. In practice this is a malformed id in a
    // path or query parameter.
    case 'P2023':
      return new ValidationError({
        code: 'INVALID_IDENTIFIER',
        message: 'An identifier in this request is not a valid UUID.',
        details: [{ issue: 'invalid_format' }],
      });
    // P2025 — a required record was not found for the operation.
    case 'P2025':
      return new NotFoundError({ message: 'Resource not found.' });
    default:
      return err;
  }
}
