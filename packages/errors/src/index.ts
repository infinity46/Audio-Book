/**
 * Normalized application error taxonomy.
 *
 * Source of truth: docs/architecture/api-specification.md §8 (error envelope,
 * class -> HTTP status mapping) and §21 (error code registry). One error code
 * maps to exactly one HTTP status; the envelope shape below is verbatim from
 * §8.1 and must never carry stack traces, exception names, file paths, SQL,
 * queue/Redis/storage keys, hostnames, signed URLs, or book text (§8.2).
 */

export type ErrorCategory =
  | 'VALIDATION'
  | 'MALFORMED'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'GONE'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'QUOTA'
  | 'DEPENDENCY_FAILURE'
  | 'QUEUE_FAILURE'
  | 'STORAGE_FAILURE'
  | 'INTERNAL';

const CATEGORY_HTTP_STATUS: Record<ErrorCategory, number> = {
  VALIDATION: 422,
  MALFORMED: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  GONE: 410,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  QUOTA: 429,
  DEPENDENCY_FAILURE: 502,
  QUEUE_FAILURE: 503,
  STORAGE_FAILURE: 503,
  INTERNAL: 500,
};

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    request_id: string;
    trace_id: string;
    retryable: boolean;
    documentation_url?: string;
  };
}

export interface AppErrorOptions {
  /** SCREAMING_SNAKE_CASE, unique, one meaning, one HTTP status. */
  code: string;
  message: string;
  category: ErrorCategory;
  details?: ErrorDetail[];
  retryable?: boolean;
  documentationUrl?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly details?: ErrorDetail[];
  readonly retryable: boolean;
  readonly documentationUrl?: string;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.category = options.category;
    this.httpStatus = CATEGORY_HTTP_STATUS[options.category];
    this.details = options.details;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.category];
    this.documentationUrl = options.documentationUrl;
  }
}

const DEFAULT_RETRYABLE: Record<ErrorCategory, boolean> = {
  VALIDATION: false,
  MALFORMED: false,
  AUTHENTICATION: false,
  AUTHORIZATION: false,
  NOT_FOUND: false,
  METHOD_NOT_ALLOWED: false,
  GONE: false,
  CONFLICT: false,
  PAYLOAD_TOO_LARGE: false,
  UNSUPPORTED_MEDIA: false,
  QUOTA: true,
  DEPENDENCY_FAILURE: true,
  QUEUE_FAILURE: true,
  STORAGE_FAILURE: true,
  INTERNAL: false,
};

/**
 * Each concrete error class is declared explicitly (rather than via a
 * `class extends factory(...)` mixin) so `extends Error` stays a nominal,
 * statically-provable relationship in every consuming package's compiled
 * .d.ts — a dynamic factory return type erases that link structurally,
 * which both defeats `instanceof Error` narrowing downstream and trips
 * lint rules that require throwing a real Error subtype.
 */
type SubclassOptions = Omit<AppErrorOptions, 'category' | 'code'> & { code?: string };

export class ValidationError extends AppError {
  constructor(options: SubclassOptions = { message: 'Validation failed.' }) {
    super({ ...options, code: options.code ?? 'VALIDATION_FAILED', category: 'VALIDATION' });
  }
}

export class MalformedRequestError extends AppError {
  constructor(options: SubclassOptions = { message: 'Malformed request.' }) {
    super({ ...options, code: options.code ?? 'MALFORMED_REQUEST', category: 'MALFORMED' });
  }
}

export class AuthenticationError extends AppError {
  constructor(options: SubclassOptions = { message: 'Authentication required.' }) {
    super({ ...options, code: options.code ?? 'UNAUTHENTICATED', category: 'AUTHENTICATION' });
  }
}

export class AuthorizationError extends AppError {
  constructor(options: SubclassOptions = { message: 'Not authorized.' }) {
    super({ ...options, code: options.code ?? 'FORBIDDEN', category: 'AUTHORIZATION' });
  }
}

export class NotFoundError extends AppError {
  constructor(options: SubclassOptions = { message: 'Resource not found.' }) {
    super({ ...options, code: options.code ?? 'RESOURCE_NOT_FOUND', category: 'NOT_FOUND' });
  }
}

/**
 * `api-specification.md` §9.1/§9.2: a method the resource *never* supports —
 * `PATCH` on an immutable `AudioChunk`, say. Deliberately distinct from
 * `ConflictError`: a `409` means the resource supports the method but its
 * current **state** forbids it, so the same call succeeds in another state.
 * Collapsing the two would make the distinction the specification calls
 * "contractual and testable" untestable.
 */
export class MethodNotAllowedError extends AppError {
  constructor(options: SubclassOptions = { message: 'Method not allowed for this resource.' }) {
    super({
      ...options,
      code: options.code ?? 'METHOD_NOT_ALLOWED',
      category: 'METHOD_NOT_ALLOWED',
    });
  }
}

export class GoneError extends AppError {
  constructor(options: SubclassOptions = { message: 'Resource is gone.' }) {
    super({ ...options, code: options.code ?? 'RESOURCE_GONE', category: 'GONE' });
  }
}

export class ConflictError extends AppError {
  constructor(options: SubclassOptions = { message: 'Conflict.' }) {
    super({ ...options, code: options.code ?? 'CONFLICT', category: 'CONFLICT' });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(options: SubclassOptions = { message: 'Request payload too large.' }) {
    super({ ...options, code: options.code ?? 'REQUEST_TOO_LARGE', category: 'PAYLOAD_TOO_LARGE' });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(options: SubclassOptions = { message: 'Unsupported media type.' }) {
    super({
      ...options,
      code: options.code ?? 'UNSUPPORTED_MEDIA_TYPE',
      category: 'UNSUPPORTED_MEDIA',
    });
  }
}

export class QuotaExceededError extends AppError {
  constructor(options: SubclassOptions = { message: 'Rate limit exceeded.' }) {
    super({ ...options, code: options.code ?? 'RATE_LIMITED', category: 'QUOTA' });
  }
}

export class DependencyFailureError extends AppError {
  constructor(options: SubclassOptions = { message: 'A dependency is unavailable.' }) {
    super({
      ...options,
      code: options.code ?? 'DEPENDENCY_UNAVAILABLE',
      category: 'DEPENDENCY_FAILURE',
    });
  }
}

export class QueueFailureError extends AppError {
  constructor(options: SubclassOptions = { message: 'The queue is unavailable.' }) {
    super({ ...options, code: options.code ?? 'QUEUE_UNAVAILABLE', category: 'QUEUE_FAILURE' });
  }
}

export class StorageFailureError extends AppError {
  constructor(options: SubclassOptions = { message: 'Object storage is unavailable.' }) {
    super({ ...options, code: options.code ?? 'STORAGE_UNAVAILABLE', category: 'STORAGE_FAILURE' });
  }
}

export class InternalError extends AppError {
  constructor(options: SubclassOptions = { message: 'Internal error.' }) {
    super({ ...options, code: options.code ?? 'INTERNAL_ERROR', category: 'INTERNAL' });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Converts any thrown value into the API's error envelope. Never surfaces
 * internals of unrecognized errors (stack traces, messages that may contain
 * SQL/paths/etc.) — those collapse to a generic INTERNAL_ERROR message.
 */
export function toErrorEnvelope(err: unknown, requestId: string, traceId: string): ErrorEnvelope {
  if (isAppError(err)) {
    return {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        request_id: requestId,
        trace_id: traceId,
        retryable: err.retryable,
        documentation_url: err.documentationUrl,
      },
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      request_id: requestId,
      trace_id: traceId,
      retryable: false,
    },
  };
}

export function httpStatusForError(err: unknown): number {
  return isAppError(err) ? err.httpStatus : 500;
}
