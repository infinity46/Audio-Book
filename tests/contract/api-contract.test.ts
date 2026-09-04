import { describe, expect, it } from 'vitest';
import { AjvValidationPipe } from '@audio-book/api/common/pipes/ajv-validation.pipe';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  GoneError,
  MalformedRequestError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  QuotaExceededError,
  UnsupportedMediaTypeError,
  ValidationError,
  toErrorEnvelope,
} from '@audio-book/errors';
import {
  BookStatus,
  DeliveryFormat,
  DeliveryMode,
  Emotion,
  JobStatus,
  JobType,
} from '@audio-book/database';
import {
  cancelJobSchema,
  replayJobSchema,
  updateBookSchema,
  updateCurrentUserSchema,
  updateTenantQuotasSchema,
} from '@audio-book/contracts';

/**
 * Contract tests against `api-specification.md` (§22.5, §124 of the Phase 8
 * brief).
 *
 * These assert the parts of the contract that are **structural** — status
 * mappings, closed vocabularies, request-schema strictness — and can therefore
 * be checked without a running server, in milliseconds, on every commit. The
 * behavioural half of the contract (ownership, idempotency, `202` semantics,
 * cancellation state transitions) needs a real stack and lives in
 * `tests/e2e/application-layer.e2e.test.ts`.
 *
 * The point of separating them is that this file catches the class of drift
 * that a code change causes silently: someone adds an enum member, renames a
 * status, or relaxes a schema, and nothing else notices until a client breaks.
 *
 * Schemas are exercised through the API's **own** `AjvValidationPipe`, not
 * through a locally-configured Ajv. A second Ajv instance here could be
 * configured differently from the one the server runs — different `strict`,
 * different `removeAdditional` — and would then happily pass a body the real
 * API rejects, or vice versa. Testing the actual enforcement path is the only
 * version of this test that means anything.
 */

/** Returns true when the pipe accepts the body; false when it raises a ValidationError. */
function accepts(schema: object, body: unknown): boolean {
  try {
    new AjvValidationPipe(schema).transform(body);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// §8.4 / §9.1 — one error class, one HTTP status
// --------------------------------------------------------------------------

describe('error class → HTTP status (§8.4, §9.1)', () => {
  const cases: [string, { httpStatus: number; code: string }, number][] = [
    ['MalformedRequestError', new MalformedRequestError({ message: 'x' }), 400],
    ['AuthenticationError', new AuthenticationError({ message: 'x' }), 401],
    ['AuthorizationError', new AuthorizationError({ message: 'x' }), 403],
    ['NotFoundError', new NotFoundError({ message: 'x' }), 404],
    ['MethodNotAllowedError', new MethodNotAllowedError({ message: 'x' }), 405],
    ['ConflictError', new ConflictError({ message: 'x' }), 409],
    ['GoneError', new GoneError({ message: 'x' }), 410],
    ['PayloadTooLargeError', new PayloadTooLargeError({ message: 'x' }), 413],
    ['UnsupportedMediaTypeError', new UnsupportedMediaTypeError({ message: 'x' }), 415],
    ['ValidationError', new ValidationError({ message: 'x' }), 422],
    ['QuotaExceededError', new QuotaExceededError({ message: 'x' }), 429],
  ];

  it.each(cases)('%s → %d', (_name, error, status) => {
    expect(error.httpStatus).toBe(status);
  });

  it('405 is expressible, and distinct from 409 (§9.2)', () => {
    // "The distinction is contractual and testable": 405 means the resource
    // never supports the method; 409 means its current state forbids it.
    // Collapsing them would make that untestable.
    expect(new MethodNotAllowedError({ message: 'x' }).httpStatus).toBe(405);
    expect(new ConflictError({ message: 'x' }).httpStatus).toBe(409);
  });
});

describe('error envelope (§8.1, §8.2)', () => {
  it('carries every contractual field', () => {
    const envelope = toErrorEnvelope(
      new ValidationError({
        message: 'Bad field.',
        details: [{ field: 'scope', issue: 'invalid_enum' }],
      }),
      'req-1',
      'trace-1',
    );
    expect(envelope.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Bad field.',
      request_id: 'req-1',
      trace_id: 'trace-1',
      retryable: false,
    });
    expect(envelope.error.details).toEqual([{ field: 'scope', issue: 'invalid_enum' }]);
  });

  it('collapses an unrecognized throwable rather than leaking its message', () => {
    const leaky = new Error(
      'SELECT * FROM book WHERE id = $1 failed at /Users/someone/app/src/db.ts:42',
    );
    const envelope = toErrorEnvelope(leaky, 'req-1', 'trace-1');

    // §8.2: an error must never carry SQL, file paths, or an exception's own
    // message from an unrecognized source.
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).not.toContain('SELECT');
    expect(envelope.error.message).not.toContain('/Users/');
  });
});

// --------------------------------------------------------------------------
// §20 — closed state vocabularies
// --------------------------------------------------------------------------

describe('state vocabularies are exactly those of §20 (closed, not extensible in v1)', () => {
  it('§20.1 Book.status — the sixteen states', () => {
    expect(Object.values(BookStatus).sort()).toEqual(
      [
        'ANALYZED',
        'ANALYZING',
        'ASSEMBLING',
        'CASTING',
        'CANCELLED',
        'COMPLETED',
        'CREATED',
        'FAILED',
        'GENERATING',
        'NEEDS_REVIEW',
        'PARSED',
        'PARSING',
        'SCRIPTED',
        'SCRIPTING',
        'STRUCTURED',
        'UPLOADED',
      ].sort(),
    );
  });

  it('§20.2 ProcessingJob.status — nine states, including BLOCKED and DEAD_LETTERED', () => {
    // The commissioning brief listed seven; `context.md` §16.1 defines nine and
    // §25.8 forbids inventing a vocabulary. Conflict C-7 resolved to nine.
    expect(Object.values(JobStatus).sort()).toEqual(
      [
        'BLOCKED',
        'CANCELLED',
        'CREATED',
        'DEAD_LETTERED',
        'FAILED',
        'QUEUED',
        'RETRYING',
        'RUNNING',
        'SUCCEEDED',
      ].sort(),
    );
  });

  it('§20.3 ProcessingJob.type — the seventeen job types', () => {
    expect(Object.values(JobType)).toHaveLength(17);
    expect(Object.values(JobType)).toContain('generate_tts_chunk');
    expect(Object.values(JobType)).toContain('assemble_audiobook');
  });

  it('director-specification.md §4.1 — seventeen emotions', () => {
    expect(Object.values(Emotion)).toHaveLength(17);
  });

  it('eight delivery modes and three delivery formats', () => {
    expect(Object.values(DeliveryMode)).toHaveLength(8);
    expect(Object.values(DeliveryFormat).sort()).toEqual(['M4A', 'M4B', 'MP3_PER_CHAPTER']);
  });
});

// --------------------------------------------------------------------------
// §12 / §2.9 — request validation is strict
// --------------------------------------------------------------------------

describe('request schemas reject unknown fields (§2.9 strict mode)', () => {
  const schemas: [string, object, Record<string, unknown>][] = [
    ['cancel-job', cancelJobSchema, { reason: 'ok' }],
    ['replay-job', replayJobSchema, { reason: 'ok' }],
    ['update-book', updateBookSchema, { title: 'A Title' }],
    ['update-current-user', updateCurrentUserSchema, { display_name: 'Reader' }],
    ['update-tenant-quotas', updateTenantQuotasSchema, { concurrent_books: 3 }],
  ];

  it.each(schemas)('%s accepts a valid body', (_name, schema, valid) => {
    expect(accepts(schema, valid)).toBe(true);
  });

  it.each(schemas)(
    '%s rejects an unknown field rather than dropping it',
    (_name, schema, valid) => {
      // §2.9: "Unknown fields in a request body are rejected, not ignored."
      // Silently dropping one means the API did something other than what the
      // caller asked, without saying so.
      expect(accepts(schema, { ...valid, definitely_not_a_field: true })).toBe(false);
    },
  );
});

describe('request schemas enforce the documented field constraints (§12.3)', () => {
  it('cancel-job caps the free-text reason at 512 characters', () => {
    expect(accepts(cancelJobSchema, { reason: 'x'.repeat(512) })).toBe(true);
    expect(accepts(cancelJobSchema, { reason: 'x'.repeat(513) })).toBe(false);
  });

  it('update-book refuses an empty patch', () => {
    // A PATCH with no fields is a request that means nothing; accepting it
    // would bump `row_version` and invalidate other clients' ETags for free.
    expect(accepts(updateBookSchema, {})).toBe(false);
  });

  it('update-book does not accept `status` — pipeline state is never patchable (§16.5)', () => {
    expect(accepts(updateBookSchema, { status: 'COMPLETED' })).toBe(false);
  });

  it('update-book validates the language tag shape', () => {
    expect(accepts(updateBookSchema, { language: 'en-GB' })).toBe(true);
    expect(accepts(updateBookSchema, { language: 'english please' })).toBe(false);
  });

  it('update-current-user accepts neither email nor roles (§16.2)', () => {
    // An email change is an auth-domain operation; roles are administrative.
    expect(accepts(updateCurrentUserSchema, { email: 'new@example.com' })).toBe(false);
    expect(accepts(updateCurrentUserSchema, { roles: ['PLATFORM_ADMIN'] })).toBe(false);
  });

  it('update-tenant-quotas refuses a negative limit', () => {
    expect(accepts(updateTenantQuotasSchema, { concurrent_books: -1 })).toBe(false);
  });
});
