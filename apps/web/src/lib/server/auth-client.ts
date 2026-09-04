import 'server-only';

import { ApiError, parseApiErrorBody } from '@/lib/api/errors';
import { serverConfig } from './env';

/**
 * The BFF's own client for the token-issuance endpoints
 * (`api-specification.md` §16.1, implemented Phase 10). Deliberately
 * separate from `lib/api/client.ts`: that client always goes through
 * `/bff/**` and attaches the session cookie's bearer token — but register/
 * login/logout either have no session yet or are managing the session
 * itself, so these call the application API directly, server-side, the same
 * way `session.ts`'s `verifyToken` already reaches past the proxy for the
 * same reason.
 */

async function callAuthEndpoint<T>(
  path: string,
  init: { method: 'POST'; body: unknown },
): Promise<T> {
  const { apiBaseUrl } = serverConfig();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'The studio API could not be reached.',
      retryable: true,
    });
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A non-JSON body (e.g. a 204) is fine for callers that ignore the return value.
  }

  if (!response.ok) {
    throw parseApiErrorBody(response.status, json, response.headers);
  }
  return (json as { data: T })?.data;
}

export interface LoginResult {
  status: 'AUTHENTICATED' | 'MFA_REQUIRED';
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  mfa_token?: string;
}

/** `POST /api/v1/auth/login`. Always `client_type: "API"` — this BFF wants the raw token back, not a cookie from the upstream API (it manages its own). */
export function login(email: string, password: string): Promise<LoginResult> {
  return callAuthEndpoint<LoginResult>('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password, client_type: 'API' },
  });
}

export interface RegisterResult {
  status: 'REGISTRATION_PENDING' | 'CREATED';
}

/** `POST /api/v1/auth/register`. See the endpoint's own docstring on enumeration protection. */
export function register(
  email: string,
  password: string,
  displayName: string | null,
): Promise<RegisterResult> {
  return callAuthEndpoint<RegisterResult>('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password, display_name: displayName },
  });
}

/** `POST /api/v1/auth/logout`. Best-effort: a failure here must never block clearing the local cookie. */
export async function logout(accessToken: string): Promise<void> {
  const { apiBaseUrl } = serverConfig();
  try {
    await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    // The session cookie is cleared regardless — see actions.ts#signOutAction.
    // A logout that cannot reach the API leaves the server-side session to
    // expire naturally rather than blocking the user from leaving locally.
  }
}
