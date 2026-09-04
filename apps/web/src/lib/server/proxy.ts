import 'server-only';

import { serverConfig } from './env';
import { readSessionToken } from './session';

/**
 * The BFF proxy (Phase 9 rules 1, 121, 128).
 *
 * Browser ──same-origin──► /bff/api/v1/**  ──bearer──► Application API
 *
 * Properties this arrangement buys, none of which a direct browser→API call
 * has:
 *
 *  - The credential never enters the browser's JavaScript heap or storage. It
 *    is read from an httpOnly cookie *here* and attached *here*.
 *  - CSRF: writes are refused unless `Origin` matches this app (`SameSite=Lax`
 *    already blocks the common cases; this closes the rest).
 *  - Only `/api/v1/**` is reachable. The API's `internal/v1/**`, `/metrics`,
 *    and `/health/dependencies` surfaces are not proxied at all, so a bug in a
 *    client cannot reach them.
 *  - Response bytes are streamed, never buffered — which is what lets the same
 *    handler carry an SSE stream (rule 43) without holding it in memory.
 *
 * Audio bytes deliberately do **not** pass through here: those come from a
 * signed object-storage URL the client fetches directly (rule 63).
 */

/** Only the public v1 surface is proxied. Everything else is refused. */
const ALLOWED_PATH = /^api\/v1\//;

/** Request headers forwarded upstream. An allowlist, not a denylist. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'last-event-id',
  'accept-language',
];

/** Response headers forwarded back. Never `set-cookie`. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'location',
  'cache-control',
  'retry-after',
  'x-request-id',
  'x-trace-id',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
];

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export class ProxyRefusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  // Same envelope shape the API uses, so the client's one error parser handles
  // a BFF refusal identically to an API refusal (`error-handling.md` §1).
  return new Response(
    JSON.stringify({
      error: { code, message, details: [], request_id: null, trace_id: null, retryable: false },
    }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

/**
 * Rejects a cross-site write. `SameSite=Lax` already withholds the cookie from
 * cross-site POSTs in every browser that honours it; this is the belt to that
 * suspenders, and it also catches a same-site-but-wrong-origin caller.
 */
function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin) return; // Non-browser client; the cookie would not be attached anyway.
  const expected = serverConfig().publicOrigin ?? new URL(request.url).origin;
  if (origin !== expected) {
    throw new ProxyRefusal(403, 'FORBIDDEN', 'Cross-origin request refused.');
  }
}

export async function proxyToApi(request: Request, pathSegments: string[]): Promise<Response> {
  const path = pathSegments.join('/');
  if (!ALLOWED_PATH.test(path)) {
    return errorResponse(
      404,
      'RESOURCE_NOT_FOUND',
      'Only the public /api/v1 surface is reachable through this application.',
    );
  }

  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof ProxyRefusal) return errorResponse(err.status, err.code, err.message);
    throw err;
  }

  const token = await readSessionToken();
  if (!token) {
    return errorResponse(401, 'UNAUTHENTICATED', 'No active session. Sign in again.');
  }

  const incoming = new URL(request.url);
  const target = `${serverConfig().apiBaseUrl}/${path}${incoming.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${token}`);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: SAFE_METHODS.has(request.method) ? undefined : await request.text(),
      // Never follow a redirect on the user's behalf: an open redirect through
      // an authenticated proxy would forward the bearer to wherever it points.
      redirect: 'manual',
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return errorResponse(
      503,
      'DEPENDENCY_UNAVAILABLE',
      'The studio API could not be reached. Try again in a moment.',
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has('cache-control')) responseHeaders.set('cache-control', 'no-store');
  // Nothing this proxy returns is ever a document the browser should sniff.
  responseHeaders.set('x-content-type-options', 'nosniff');

  // The body is passed through as a stream. For `text/event-stream` that is
  // the whole point: the SSE frames reach the browser as they are produced,
  // and no part of an open-ended stream is ever accumulated here.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
