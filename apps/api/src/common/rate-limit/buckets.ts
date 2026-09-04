/**
 * Bucket assignment for api-specification.md §14.3.
 *
 * Derived from the request itself rather than from a per-route decorator on
 * purpose: a decorator that someone forgets to add leaves that route with no
 * limit at all, which is the one failure mode a rate limiter must not have.
 * Deriving means every request lands in exactly one bucket, and a new route
 * inherits a sane limit the day it is added.
 */

export type RateLimitBucket = 'read' | 'write' | 'upload' | 'expensive' | 'access_url' | 'auth';

/** Pipeline-starting sub-resources — §14.3's `expensive` bucket. */
const EXPENSIVE_SEGMENTS = [
  'ingestion',
  'analysis',
  'director',
  'tts',
  'assembly',
  'previews',
  'casting',
  'character-merges',
];

export function resolveBucket(method: string, path: string): RateLimitBucket {
  const verb = method.toUpperCase();
  // Strip the query string and any trailing slash before matching segments.
  const pathname = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  const segments = pathname.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';

  // §14.3: `/auth/**` is its own, strictest bucket — checked before the
  // GET/HEAD short-circuit below because it also governs the read-shaped
  // parts of that surface (there are none today, but a future GET under
  // /auth/** must not silently fall into the much larger `read` bucket).
  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'auth') return 'auth';

  if (verb === 'GET' || verb === 'HEAD') return 'read';

  // Signed-URL minting has its own bucket regardless of what it hangs off.
  if (last === 'access-urls') return 'access_url';

  // Upload-session creation, completion, and abort.
  if (segments.includes('upload-sessions')) return 'upload';

  if (EXPENSIVE_SEGMENTS.includes(last)) return 'expensive';
  // `POST .../voice-profile-versions/:id/previews` and similar nested starts.
  if (segments.some((s) => EXPENSIVE_SEGMENTS.includes(s)) && verb === 'POST') return 'expensive';

  return 'write';
}
