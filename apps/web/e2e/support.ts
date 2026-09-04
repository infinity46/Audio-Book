import { expect, type Page, type Request } from '@playwright/test';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_PRIVATE_KEY_PEM,
} from './fixtures/test-key';

export const MOCK_API = 'http://localhost:4010';

/**
 * Mints a token the studio will accept, exactly as the deployment's identity
 * provider would. The studio issues no credentials of its own — it verifies an
 * externally-issued RS256 bearer — so this is how a test signs in.
 */
export async function mintToken(
  claims: { sub?: string; tenantId?: string; roles?: string[]; expiresIn?: string } = {},
): Promise<string> {
  const key = createPrivateKey(TEST_PRIVATE_KEY_PEM);
  return new SignJWT({
    tenant_id: claims.tenantId ?? 'tenant-e2e',
    roles: claims.roles ?? ['TENANT_OWNER'],
    scopes: [],
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(claims.sub ?? 'user-e2e')
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(key);
}

/**
 * Gets a test authenticated without exercising the sign-in form — the studio
 * now has a real login flow (Phase 10, `api-specification.md` §16.1), and
 * most specs only need *to be* signed in, not to re-test the form itself
 * (that is `workflow.spec.ts`'s job). Sets the session cookie directly, the
 * same shape `startSession` would produce
 * (`apps/web/src/lib/server/session.ts`) — httpOnly, `SameSite=Lax`,
 * non-`Secure` in this suite's `SESSION_COOKIE_SECURE=false` configuration.
 */
export async function signIn(page: Page, options: { expiresIn?: string } = {}): Promise<void> {
  const token = await mintToken(options);
  // `/sign-in` is reachable with no session and establishes a concrete
  // origin to attach the cookie to — a fresh page's `page.url()` is
  // `about:blank`, which is not a valid cookie target.
  await page.goto('/sign-in');
  await page.context().addCookies([
    {
      name: 'audiobook_session',
      value: token,
      url: new URL(page.url()).origin,
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
  await page.goto('/');
  await expect(page).toHaveURL(/\/$|\/projects/);
}

/** Exercises the real sign-in form (email/password) against the mock API's `/api/v1/auth/login`. */
export async function signInViaForm(
  page: Page,
  credentials: { email?: string; password?: string } = {},
): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(credentials.email ?? 'reader@example.com');
  await page.getByLabel('Password').fill(credentials.password ?? 'correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function resetApi(): Promise<void> {
  await fetch(`${MOCK_API}/__control/reset`, { method: 'POST' });
}

export async function failNext(path: string, status: number, code: string): Promise<void> {
  await fetch(`${MOCK_API}/__control/fail-next`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, status, code }),
  });
}

/** Moves a book's TTS stage on, the way a fleet of workers would. */
export async function advance(body: Record<string, unknown>): Promise<void> {
  await fetch(`${MOCK_API}/__control/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every request the page makes to its own BFF. */
export function trackBffRequests(page: Page): { requests: Request[] } {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/bff/api/v1/')) requests.push(request);
  });
  return { requests };
}
