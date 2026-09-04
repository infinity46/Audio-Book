import 'server-only';

/**
 * Server-only configuration (Phase 9 rules 121–122).
 *
 * None of these are `NEXT_PUBLIC_`, so none of them reach the browser bundle.
 * The browser never learns the API's address, and never sees a credential:
 * every call it makes is same-origin, to this app's own `/bff` mount.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not configured. See apps/web/.env.example — the web app cannot start without it.`,
    );
  }
  return value;
}

export interface WebServerConfig {
  /** Internal address of the Phase 8 application API. Never sent to a client. */
  apiBaseUrl: string;
  auth: {
    issuer: string;
    audience: string;
    jwksUrl?: string;
    publicKey?: string;
  };
  /** `Secure` on the session cookie. Off only for plain-HTTP local development. */
  cookieSecure: boolean;
  /** Public origin of this app, used for strict same-origin checks on writes. */
  publicOrigin: string | undefined;
}

let cached: WebServerConfig | undefined;

export function serverConfig(): WebServerConfig {
  if (cached) return cached;
  const jwksUrl = process.env.AUTH_JWT_JWKS_URL?.trim() || undefined;
  const publicKey = process.env.AUTH_JWT_PUBLIC_KEY?.trim() || undefined;

  if (!jwksUrl && !publicKey) {
    throw new Error(
      'Neither AUTH_JWT_JWKS_URL nor AUTH_JWT_PUBLIC_KEY is set. The web app verifies the ' +
        'identity provider’s token before it will hold a session, and cannot do so without ' +
        'one of them. This mirrors the API’s own JwtAuthGuard configuration.',
    );
  }

  cached = {
    apiBaseUrl: (process.env.AUDIOBOOK_API_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    auth: {
      issuer: required('AUTH_JWT_ISSUER', process.env.AUTH_JWT_ISSUER),
      audience: required('AUTH_JWT_AUDIENCE', process.env.AUTH_JWT_AUDIENCE),
      jwksUrl,
      publicKey,
    },
    cookieSecure: process.env.SESSION_COOKIE_SECURE !== 'false',
    publicOrigin: process.env.WEB_PUBLIC_ORIGIN?.trim() || undefined,
  };
  return cached;
}

/** Test seam — configuration is read once per process in production. */
export function resetServerConfigCache(): void {
  cached = undefined;
}
