/**
 * The single API client (Phase 9 rule 99 — no raw `fetch` in components).
 *
 * Everything goes through this app's own BFF (`/bff/**`), never to the
 * application API directly. That is what keeps the bearer credential in an
 * httpOnly cookie the browser cannot read (rule 121) and what makes the
 * browser's own same-origin policy the CSRF boundary (rule 128).
 */

import { ApiError, NetworkError, parseApiErrorBody } from './errors';
import type { Collection, Envelope } from './types';

/** The BFF mount point. Requests are same-origin by construction. */
export const BFF_PREFIX = '/bff';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Required by the API on expensive, state-changing POSTs
   * (`error-handling.md` §6). Reuse the same key when retrying the same intent
   * — that is what makes a retry after a network timeout safe.
   */
  idempotencyKey?: string;
  /** Optimistic concurrency on mutable resources (§4). */
  ifMatch?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Automatic retries. Defaults to on for safe methods only: the contract is
   * explicit that an expensive POST must never be repeated on the client's own
   * initiative (rule 78).
   */
  retry?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  etag: string | null;
  requestId: string | null;
  traceId: string | null;
  status: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const MAX_AUTO_RETRIES = 3;

export function buildPath(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/** UUIDv4 for `Idempotency-Key`, with a fallback for non-secure contexts. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Full-jitter backoff, the same shape the job system uses. `Retry-After` wins
 * where the API supplied one (`error-handling.md` §5).
 */
function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  const ceiling = Math.min(1000 * 2 ** attempt, 8000);
  return Math.random() * ceiling;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? 'GET';
  const url = `${BFF_PREFIX}${buildPath(path, options.query)}`;
  const retryEnabled = options.retry ?? SAFE_METHODS.has(method);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;

  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        // Same-origin: the session cookie rides along, the bearer never does.
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      // Offline / DNS / connection reset. Safe methods may be retried.
      if (retryEnabled && attempt < MAX_AUTO_RETRIES) {
        await sleep(backoffMs(attempt, null), options.signal);
        attempt += 1;
        continue;
      }
      throw new NetworkError('The studio could not be reached.', cause);
    }

    const requestId = response.headers.get('x-request-id');
    const traceId = response.headers.get('x-trace-id');

    if (response.ok) {
      const body = (await readBody(response)) as T;
      return {
        data: body,
        etag: response.headers.get('etag'),
        requestId,
        traceId,
        status: response.status,
      };
    }

    const error = parseApiErrorBody(response.status, await readBody(response), response.headers);

    // Rule 78: only safe, idempotent requests are repeated automatically, and
    // only when the API itself says a repeat could succeed.
    const shouldRetry = retryEnabled && error.retryable && attempt < MAX_AUTO_RETRIES;
    if (shouldRetry) {
      await sleep(backoffMs(attempt, error.retryAfterSeconds), options.signal);
      attempt += 1;
      continue;
    }
    throw error;
  }
}

/** `{ data: … }` single-resource reads. */
export async function getOne<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await request<Envelope<T>>(path, options);
  return response.data.data;
}

/** As `getOne`, but keeps the `ETag` for a later `If-Match` write. */
export async function getVersioned<T>(
  path: string,
  options?: RequestOptions,
): Promise<{ data: T; etag: string | null }> {
  const response = await request<Envelope<T>>(path, options);
  return { data: response.data.data, etag: response.etag };
}

/** `{ data: [...], page: {...} }` collection reads. */
export async function getPage<T>(
  path: string,
  options?: RequestOptions,
): Promise<Collection<T>> {
  const response = await request<Collection<T>>(path, options);
  return response.data;
}

/**
 * Walks `page.next_cursor` to completion.
 *
 * Only for collections that are bounded by one project — a book's cast, its
 * chapter list — and never for a tenant-wide collection, which is paginated in
 * the UI instead (rule 118). `maxPages` is a hard stop so a runaway cursor
 * cannot pin the browser.
 */
export async function getAllPages<T>(
  path: string,
  options: RequestOptions & { maxPages?: number; pageSize?: number } = {},
): Promise<T[]> {
  const { maxPages = 40, pageSize = 100, ...rest } = options;
  const out: T[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await getPage<T>(path, {
      ...rest,
      query: { ...rest.query, limit: pageSize, cursor: cursor ?? undefined },
    });
    out.push(...page.data);
    if (!page.page.has_more || !page.page.next_cursor) return out;
    cursor = page.page.next_cursor;
  }
  return out;
}

export async function post<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request<Envelope<T>>(path, { ...options, method: 'POST' });
  return response.data?.data;
}

export async function patch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; etag: string | null }> {
  const response = await request<Envelope<T>>(path, { ...options, method: 'PATCH' });
  return { data: response.data.data, etag: response.etag };
}

export async function put<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request<Envelope<T>>(path, { ...options, method: 'PUT' });
  return response.data?.data;
}

export async function del(path: string, options: RequestOptions = {}): Promise<void> {
  await request<never>(path, { ...options, method: 'DELETE' });
}

export { ApiError, NetworkError };
