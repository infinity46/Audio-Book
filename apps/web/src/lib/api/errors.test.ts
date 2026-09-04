import { describe, expect, it } from 'vitest';
import { ApiError, describeError, NetworkError, parseApiErrorBody } from './errors';

/**
 * `error-handling.md` §9 is a checklist, and these are its load-bearing items:
 * branch on `code` not `message`; treat an unknown code as its status class;
 * distinguish `RATE_LIMITED` from `QUOTA_EXCEEDED`.
 */
describe('parseApiErrorBody', () => {
  it('reads the §8 envelope, including request and trace ids', () => {
    const error = parseApiErrorBody(409, {
      error: {
        code: 'CASTING_INCOMPLETE',
        message: 'Some chunks have no resolvable voice.',
        details: [{ field: 'scope', issue: 'invalid_enum' }],
        request_id: 'req-1',
        trace_id: 'trace-1',
        retryable: false,
      },
    });
    expect(error.code).toBe('CASTING_INCOMPLETE');
    expect(error.status).toBe(409);
    expect(error.requestId).toBe('req-1');
    expect(error.traceId).toBe('trace-1');
    expect(error.retryable).toBe(false);
  });

  it('synthesizes a code when something upstream of the API answered', () => {
    // A gateway or proxy can return a bare 502 with no envelope. Callers must
    // still be able to branch on `code`.
    const error = parseApiErrorBody(502, '<html>Bad Gateway</html>');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.retryable).toBe(true);
  });

  it('reads Retry-After from the headers for a 429', () => {
    const error = parseApiErrorBody(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down.', retryable: true, request_id: null, trace_id: null } },
      new Headers({ 'retry-after': '30' }),
    );
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe('describeError', () => {
  it('never puts the raw code in the headline', () => {
    const presentation = describeError(
      new ApiError({ status: 409, code: 'AUDIO_SCRIPT_NOT_VALIDATED', message: 'DRAFT, not VALIDATED.' }),
    );
    expect(presentation.title).not.toContain('AUDIO_SCRIPT_NOT_VALIDATED');
    expect(presentation.title).toMatch(/not ready/i);
  });

  it('distinguishes rate limiting from quota exhaustion', () => {
    // Both are 429. Conflating them wastes requests: one clears on its own,
    // the other never will.
    const rateLimited = describeError(
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: '', retryable: true }),
    );
    const quota = describeError(
      new ApiError({ status: 429, code: 'QUOTA_EXCEEDED', message: '', retryable: false }),
    );
    expect(rateLimited.canRetry).toBe(true);
    expect(quota.canRetry).toBe(false);
    expect(quota.message).toMatch(/will not help/i);
  });

  it('routes an expired credential to re-authentication', () => {
    const presentation = describeError(
      new ApiError({ status: 401, code: 'UNAUTHENTICATED', message: '' }),
    );
    expect(presentation.requiresAuth).toBe(true);
  });

  it('does not send a 403 to re-authentication', () => {
    // Signing in again cannot fix a role the account does not have.
    const presentation = describeError(new ApiError({ status: 403, code: 'FORBIDDEN', message: '' }));
    expect(presentation.requiresAuth).toBe(false);
    expect(presentation.canRetry).toBe(false);
  });

  it('falls back to the status class for a code added after this build', () => {
    const presentation = describeError(
      new ApiError({ status: 409, code: 'SOME_NEW_V1_CODE', message: '' }),
    );
    expect(presentation.title).toMatch(/not possible/i);
    expect(presentation.canRetry).toBe(false);
  });

  it("lets the server's own retryable flag win over the static table", () => {
    const presentation = describeError(
      new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: '', retryable: true }),
    );
    expect(presentation.canRetry).toBe(true);
  });

  it('explains an offline transport failure without blaming the user', () => {
    const presentation = describeError(new NetworkError('offline'));
    expect(presentation.canRetry).toBe(true);
    expect(presentation.message).toMatch(/nothing was lost/i);
  });

  it('surfaces the request id so a user can quote it', () => {
    const presentation = describeError(
      new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: '', requestId: 'req-9' }),
    );
    expect(presentation.requestId).toBe('req-9');
  });
});

describe('field issues', () => {
  it('turns the closed issue vocabulary into per-field form messages', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      message: '',
      details: [
        { field: 'title', issue: 'required' },
        { field: 'status', issue: 'unknown_field' },
      ],
    });
    expect(error.fieldIssues()).toEqual({
      title: 'This field is required.',
      status: 'This field is not accepted by the API.',
    });
  });
});
