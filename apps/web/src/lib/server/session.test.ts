/**
 * @vitest-environment node
 *
 * Runs in Node rather than jsdom: `jose` operates on `Uint8Array`, and jsdom's
 * `TextEncoder` produces one from a different realm, which fails jose's
 * instance check. This module is server-only code anyway, so Node is also the
 * environment it actually runs in.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';

/**
 * The session boundary verifies the identity provider's token with the *same*
 * issuer, audience, and algorithm the API's own `JwtAuthGuard` uses — so a
 * token this app accepts is one the API will accept too. It mints nothing.
 */

const ISSUER = 'https://auth.local';
const AUDIENCE = 'audiobook-api';

const cookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

let publicKeyPem: string;
let privateKey: CryptoKey;

vi.mock('./env', () => ({
  serverConfig: () => ({
    apiBaseUrl: 'http://api.internal:3000',
    auth: { issuer: ISSUER, audience: AUDIENCE, publicKey: publicKeyPem },
    cookieSecure: true,
    publicOrigin: 'https://studio.example',
  }),
}));

const sessionModule = await import('./session');

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
  sessionModule.resetKeyResolver();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function mint(claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(privateKey);
}

describe('verifyToken', () => {
  it('accepts a token from the configured issuer and extracts the principal', async () => {
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1', roles: ['TENANT_OWNER'] });
    const principal = await sessionModule.verifyToken(token);
    expect(principal.sub).toBe('user-1');
    expect(principal.tenantId).toBe('tenant-1');
    expect(principal.roles).toEqual(['TENANT_OWNER']);
  });

  it('refuses a token from another issuer', async () => {
    const token = await mint(
      { sub: 'user-1', tenant_id: 'tenant-1' },
      { issuer: 'https://evil.example' },
    );
    await expect(sessionModule.verifyToken(token)).rejects.toThrow(sessionModule.InvalidTokenError);
  });

  it('refuses a token minted for another audience', async () => {
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' }, { audience: 'other-api' });
    await expect(sessionModule.verifyToken(token)).rejects.toThrow(sessionModule.InvalidTokenError);
  });

  it('refuses an expired token', async () => {
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' }, { expiresIn: '-1h' });
    await expect(sessionModule.verifyToken(token)).rejects.toThrow(sessionModule.InvalidTokenError);
  });

  it('refuses a token missing the tenant claim the API requires', async () => {
    const token = await mint({ sub: 'user-1' });
    await expect(sessionModule.verifyToken(token)).rejects.toThrow(/tenant_id/);
  });

  it('refuses unsigned rubbish without leaking why', async () => {
    await expect(sessionModule.verifyToken('not-a-token')).rejects.toThrow(
      sessionModule.InvalidTokenError,
    );
  });
});

describe('startSession', () => {
  it('stores the credential in an httpOnly, same-site, secure cookie', async () => {
    // The whole point: a script on the page cannot read it.
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' });
    await sessionModule.startSession(token);

    const [name, value, options] = cookieStore.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('__Host-audiobook_session');
    expect(value).toBe(token);
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('never outlives the credential itself', async () => {
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' }, { expiresIn: '30m' });
    await sessionModule.startSession(token);
    const options = (cookieStore.set.mock.calls[0] as [string, string, { expires?: Date }])[2];
    expect(options.expires).toBeInstanceOf(Date);
    expect(options.expires!.getTime()).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
  });

  it('refuses to store a token it cannot verify', async () => {
    await expect(sessionModule.startSession('rubbish')).rejects.toThrow(
      sessionModule.InvalidTokenError,
    );
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe('currentPrincipal', () => {
  it('returns null for an expired session rather than throwing', async () => {
    // An expired session is a sign-in prompt, not a crash.
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' }, { expiresIn: '-1h' });
    cookieStore.get.mockReturnValue({ value: token });
    expect(await sessionModule.currentPrincipal()).toBeNull();
  });

  it('returns null when no cookie is present', async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect(await sessionModule.currentPrincipal()).toBeNull();
  });

  it('returns the principal for a valid session', async () => {
    const token = await mint({ sub: 'user-1', tenant_id: 'tenant-1' });
    cookieStore.get.mockReturnValue({ value: token });
    expect((await sessionModule.currentPrincipal())?.sub).toBe('user-1');
  });
});
