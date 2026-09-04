/**
 * One normalized error type for the whole application, and one place that
 * turns a backend error code into something a user can act on
 * (Phase 9 rules 72, 100; `docs/application/error-handling.md`).
 *
 * The rules that shape this file come straight from the error contract:
 *
 *  - **Branch on `code`, never on `message`** (§1). `message` may change and
 *    may be localized; `code` is stable and has one meaning.
 *  - **Treat an unknown `code` as its HTTP status class** (§9 rule 5). New
 *    codes may be added within `v1`, so an unrecognized one must degrade to a
 *    sensible message rather than to a blank screen.
 *  - **Retry only when `retryable` is true** (§9 rule 4) — and, on top of that,
 *    only for safe methods. See `client.ts`.
 */

import type { ApiErrorBody } from './types';

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    requestId?: string | null;
    traceId?: string | null;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
    this.requestId = init.requestId ?? null;
    this.traceId = init.traceId ?? null;
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  /** Field-level messages for a form, keyed by the `details[].field` the API named. */
  fieldIssues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details) {
      if (detail.field) out[detail.field] = ISSUE_TEXT[detail.issue] ?? detail.issue;
    }
    return out;
  }
}

/**
 * A transport failure — offline, DNS, connection reset, timeout. Distinct from
 * `ApiError` because there is no envelope, no code, and no `request_id` to
 * quote: the request never reached the API (Phase 9 rule 77).
 */
export class NetworkError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** The closed `details[].issue` vocabulary (`error-handling.md` §3). */
const ISSUE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  unknown_field: 'This field is not accepted by the API.',
  invalid_type: 'This value has the wrong type.',
  invalid_enum: 'This is not one of the accepted values.',
  invalid_format: 'This value is not in the expected format.',
  too_long: 'This value is too long.',
  too_short: 'This value is too short.',
  out_of_range: 'This value is out of range.',
  duplicate: 'This value is already used.',
};

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

export function parseApiErrorBody(
  status: number,
  body: unknown,
  headers?: Headers,
): ApiError {
  const retryAfter = headers?.get('retry-after');
  const envelope = body as Partial<ApiErrorBody> | null;
  const error = envelope?.error;

  if (error && typeof error.code === 'string') {
    return new ApiError({
      status,
      code: error.code,
      message: error.message ?? 'The request failed.',
      details: error.details ?? [],
      requestId: error.request_id ?? headers?.get('x-request-id') ?? null,
      traceId: error.trace_id ?? headers?.get('x-trace-id') ?? null,
      retryable: error.retryable ?? false,
      retryAfterSeconds: retryAfter ? Number(retryAfter) : null,
    });
  }

  // No envelope: something upstream of the API answered (a proxy, a gateway).
  // Synthesize a code from the status class so callers still branch on `code`.
  return new ApiError({
    status,
    code: syntheticCodeForStatus(status),
    message: `The server returned an unexpected ${status} response.`,
    requestId: headers?.get('x-request-id') ?? null,
    traceId: headers?.get('x-trace-id') ?? null,
    retryable: status >= 500,
    retryAfterSeconds: retryAfter ? Number(retryAfter) : null,
  });
}

function syntheticCodeForStatus(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'MALFORMED_REQUEST';
}

export interface ErrorPresentation {
  /** Short heading — what happened. */
  title: string;
  /** What the user can do about it. Never contains internals. */
  message: string;
  /** Whether offering a "Try again" control is honest for this error. */
  canRetry: boolean;
  /** Whether the user should be sent to re-authenticate. */
  requiresAuth: boolean;
  /** Support handle to display, when the API gave us one. */
  requestId: string | null;
}

/**
 * Backend code → user-facing message. Every code the application layer
 * produces (`error-handling.md` §3–§5) is here; anything else falls through to
 * the status-class default, which is what §9 rule 5 requires.
 *
 * Deliberately says nothing the API did not: no invented remediation, no
 * guesses about server internals, and no "we're working on it".
 */
const CODE_PRESENTATION: Record<string, Omit<ErrorPresentation, 'requestId'>> = {
  // --- input -----------------------------------------------------------------
  VALIDATION_FAILED: {
    title: 'Some fields need attention',
    message: 'Check the highlighted fields and try again.',
    canRetry: false,
    requiresAuth: false,
  },
  INVALID_IDENTIFIER: {
    title: 'That link is not valid',
    message: 'The address contains an identifier this workspace does not recognise.',
    canRetry: false,
    requiresAuth: false,
  },
  INVALID_CURSOR: {
    title: 'This page of results expired',
    message: 'Start again from the first page.',
    canRetry: false,
    requiresAuth: false,
  },
  MALFORMED_REQUEST: {
    title: 'The request could not be read',
    message: 'Reload the page and try again.',
    canRetry: false,
    requiresAuth: false,
  },
  MISSING_IDEMPOTENCY_KEY: {
    title: 'The request was incomplete',
    message: 'Reload the page and try again.',
    canRetry: false,
    requiresAuth: false,
  },
  UNSUPPORTED_FILE_FORMAT: {
    title: 'That file format is not supported',
    message: 'Upload a PDF or EPUB file.',
    canRetry: false,
    requiresAuth: false,
  },
  FILE_TOO_LARGE: {
    title: 'That file is too large',
    message: 'The file exceeds the upload limit for this workspace.',
    canRetry: false,
    requiresAuth: false,
  },
  // --- auth ------------------------------------------------------------------
  UNAUTHENTICATED: {
    title: 'Your session has expired',
    message: 'Sign in again to continue. Your work is saved on the server.',
    canRetry: false,
    requiresAuth: true,
  },
  FORBIDDEN: {
    title: 'You do not have access to this',
    message: 'Your account does not have permission for this action.',
    canRetry: false,
    requiresAuth: false,
  },
  ADMIN_CONTENT_ACCESS_DENIED: {
    title: 'Administrator accounts cannot open project content',
    message: 'Sign in with a workspace member account to view books and audio.',
    canRetry: false,
    requiresAuth: false,
  },
  // --- resource / state ------------------------------------------------------
  RESOURCE_NOT_FOUND: {
    title: 'Not found',
    message: 'This item does not exist, or it is not available to your workspace.',
    canRetry: false,
    requiresAuth: false,
  },
  BOOK_NOT_FOUND: {
    title: 'Project not found',
    message: 'This project does not exist, or it is not available to your workspace.',
    canRetry: false,
    requiresAuth: false,
  },
  JOB_NOT_FOUND: {
    title: 'Job not found',
    message: 'This job does not exist, or it is not available to your workspace.',
    canRetry: false,
    requiresAuth: false,
  },
  RESOURCE_GONE: {
    title: 'This item has been removed',
    message: 'It was permanently deleted and can no longer be opened.',
    canRetry: false,
    requiresAuth: false,
  },
  RESOURCE_VERSION_CONFLICT: {
    title: 'Someone else changed this first',
    message: 'Reload to see the current version, then reapply your change.',
    canRetry: false,
    requiresAuth: false,
  },
  INVALID_STATE_TRANSITION: {
    title: 'Not possible in the current state',
    message: 'The project has moved past the point where this change is allowed.',
    canRetry: false,
    requiresAuth: false,
  },
  BOOK_HAS_ACTIVE_JOBS: {
    title: 'This project still has work running',
    message: 'Cancel the running jobs first, then try again.',
    canRetry: false,
    requiresAuth: false,
  },
  IDEMPOTENCY_KEY_CONFLICT: {
    title: 'This action was already submitted differently',
    message: 'Reload the page and submit the action again.',
    canRetry: false,
    requiresAuth: false,
  },
  REQUEST_IN_PROGRESS: {
    title: 'This action is already running',
    message: 'The previous submission has not finished yet. Wait a moment and check the status.',
    canRetry: true,
    requiresAuth: false,
  },
  // --- pipeline preconditions ------------------------------------------------
  AUDIO_SCRIPT_NOT_VALIDATED: {
    title: 'The audio script is not ready',
    message: 'Run the Director stage and let it finish validating before generating audio.',
    canRetry: false,
    requiresAuth: false,
  },
  CASTING_INCOMPLETE: {
    title: 'Some characters have no voice',
    message: 'Assign a voice to every speaking character, then start generation again.',
    canRetry: false,
    requiresAuth: false,
  },
  VOICE_PROFILE_NOT_APPROVED: {
    title: 'A voice is not approved',
    message: 'Approve or lock the voice version before it can be used for generation.',
    canRetry: false,
    requiresAuth: false,
  },
  CHAPTER_MANIFEST_INCOMPLETE: {
    title: 'Not every chapter is ready to assemble',
    message: 'Some audio is still missing or invalid. Regenerate the affected chapters first.',
    canRetry: false,
    requiresAuth: false,
  },
  DIRECTOR_VERSION_MIXING_FORBIDDEN: {
    title: 'This would mix two director versions',
    message: 'Keep the existing version, or regenerate the whole book with the new one.',
    canRetry: false,
    requiresAuth: false,
  },
  ARTIFACT_NOT_READY: {
    title: 'The audio is not ready yet',
    message: 'The file has not finished being produced. Check the generation progress.',
    canRetry: true,
    requiresAuth: false,
  },
  JOB_NOT_REPLAYABLE: {
    title: 'This job cannot be replayed',
    message: 'Only failed or dead-lettered jobs can be replayed, and only by an operator.',
    canRetry: false,
    requiresAuth: false,
  },
  // --- limits ----------------------------------------------------------------
  RATE_LIMITED: {
    title: 'Too many requests',
    message: 'Slow down for a moment — this will work again shortly.',
    canRetry: true,
    requiresAuth: false,
  },
  QUOTA_EXCEEDED: {
    title: 'Workspace allowance used up',
    message:
      'Retrying will not help. Wait for running work to finish, or ask an administrator to raise the limit.',
    canRetry: false,
    requiresAuth: false,
  },
  // --- infrastructure --------------------------------------------------------
  DEPENDENCY_UNAVAILABLE: {
    title: 'A service is temporarily unavailable',
    message: 'This usually clears on its own. Try again in a moment.',
    canRetry: true,
    requiresAuth: false,
  },
  QUEUE_UNAVAILABLE: {
    title: 'The processing queue is unavailable',
    message: 'Work cannot be started right now. Try again in a moment.',
    canRetry: true,
    requiresAuth: false,
  },
  STORAGE_UNAVAILABLE: {
    title: 'File storage is unavailable',
    message: 'Uploads and downloads cannot run right now. Try again in a moment.',
    canRetry: true,
    requiresAuth: false,
  },
  INTERNAL_ERROR: {
    title: 'Something went wrong on the server',
    message: 'This has been logged. Quote the request id below if you report it.',
    canRetry: false,
    requiresAuth: false,
  },
};

/** Fallbacks by status class, for codes added to `v1` after this build. */
function presentationForStatus(status: number): Omit<ErrorPresentation, 'requestId'> {
  if (status === 401) return CODE_PRESENTATION.UNAUTHENTICATED!;
  if (status === 403) return CODE_PRESENTATION.FORBIDDEN!;
  if (status === 404) return CODE_PRESENTATION.RESOURCE_NOT_FOUND!;
  if (status === 410) return CODE_PRESENTATION.RESOURCE_GONE!;
  if (status === 409) {
    return {
      title: 'Not possible right now',
      message: 'The current state of this project does not allow that action.',
      canRetry: false,
      requiresAuth: false,
    };
  }
  if (status === 422 || status === 400 || status === 415) {
    return CODE_PRESENTATION.VALIDATION_FAILED!;
  }
  if (status === 429) return CODE_PRESENTATION.RATE_LIMITED!;
  if (status === 503 || status === 502) return CODE_PRESENTATION.DEPENDENCY_UNAVAILABLE!;
  if (status >= 500) return CODE_PRESENTATION.INTERNAL_ERROR!;
  return {
    title: 'The request could not be completed',
    message: 'Try again, or reload the page.',
    canRetry: false,
    requiresAuth: false,
  };
}

export function describeError(err: unknown): ErrorPresentation {
  if (isApiError(err)) {
    const base = CODE_PRESENTATION[err.code] ?? presentationForStatus(err.status);
    return {
      ...base,
      // `retryable` from the API wins over the static table: the server knows
      // whether *this* instance can succeed on a repeat.
      canRetry: err.retryable || base.canRetry,
      requestId: err.requestId,
    };
  }
  if (isNetworkError(err)) {
    return {
      title: 'Cannot reach the studio',
      message:
        'Check your connection. Nothing was lost — this page rebuilds itself from the server when the connection returns.',
      canRetry: true,
      requiresAuth: false,
      requestId: null,
    };
  }
  return {
    title: 'Something went wrong',
    message: 'Reload the page to continue.',
    canRetry: true,
    requiresAuth: false,
    requestId: null,
  };
}
