import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  toErrorEnvelope,
  httpStatusForError,
} from './index.js';

describe('AppError taxonomy', () => {
  it('maps each category to exactly one HTTP status', () => {
    expect(new ValidationError({ message: 'bad' }).httpStatus).toBe(422);
    expect(new NotFoundError({ message: 'missing' }).httpStatus).toBe(404);
    expect(new ConflictError({ message: 'conflict' }).httpStatus).toBe(409);
  });

  it('never leaks internals of unrecognized errors into the envelope', () => {
    const envelope = toErrorEnvelope(
      new Error('SELECT * FROM secrets WHERE token=abc'),
      'req-1',
      'trace-1',
    );
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).not.toContain('SELECT');
    expect(envelope.error.request_id).toBe('req-1');
    expect(envelope.error.trace_id).toBe('trace-1');
  });

  it('builds a well-formed envelope for a known AppError', () => {
    const err = new ValidationError({
      message: 'Invalid request body',
      details: [{ field: 'title', issue: 'required' }],
    });
    const envelope = toErrorEnvelope(err, 'req-2', 'trace-2');
    expect(envelope).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid request body',
        details: [{ field: 'title', issue: 'required' }],
        request_id: 'req-2',
        trace_id: 'trace-2',
        retryable: false,
        documentation_url: undefined,
      },
    });
  });

  it('httpStatusForError falls back to 500 for unknown errors', () => {
    expect(httpStatusForError(new Error('boom'))).toBe(500);
  });
});
