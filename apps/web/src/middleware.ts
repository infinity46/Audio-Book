import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection and path propagation (Phase 9 rules 74, 76).
 *
 * Two jobs, both about *where the user ends up*, not about security — the API
 * remains authoritative and answers `404`/`403` for anything outside the
 * caller's tenant regardless of what this file does:
 *
 *  1. A visitor with no session is sent to sign in **with the page they asked
 *     for**, so signing in returns them to it instead of dumping them on the
 *     dashboard. That is rule 76's "do not lose the user's place".
 *  2. The requested path is forwarded as a header, because a Server Component
 *     cannot otherwise learn it — which is what lets the studio layout build
 *     the same `returnTo` when a *present but expired* token is rejected.
 *
 * Deliberately only a **presence** check on the cookie. Verifying the token
 * here would put key material and a JWKS fetch on the edge for every
 * navigation, and the layout verifies it properly a moment later.
 */

const SESSION_COOKIES = ['__Host-audiobook_session', 'audiobook_session'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  const headers = new Headers(request.headers);
  headers.set('x-pathname', `${pathname}${search}`);

  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    url.searchParams.set('returnTo', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    /*
     * Everything except: the sign-in and registration pages themselves (Phase
     * 10 — a visitor with no session must be able to reach both), the BFF
     * (which returns a `401` envelope rather than a redirect, so a fetch gets
     * an error it can handle instead of an HTML login page), Next's own
     * assets, and static files.
     */
    '/((?!sign-in|register|bff|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)',
  ],
};
