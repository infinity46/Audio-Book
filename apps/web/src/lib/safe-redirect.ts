/**
 * Open-redirect guard (Phase 9 rules 126, 190).
 *
 * Only a same-site absolute path is ever followed after sign-in.
 * `//evil.example` is a protocol-relative URL that browsers resolve as
 * cross-origin, and `/\evil.example` is normalised the same way by several
 * engines — so the *second* character is checked too. A naive
 * `startsWith('/')` is exactly the check that misses both.
 *
 * Lives outside `actions.ts` because a `'use server'` module may only export
 * async functions.
 */
export function safeReturnPath(candidate: string | null | undefined): string {
  if (!candidate) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  return candidate;
}
