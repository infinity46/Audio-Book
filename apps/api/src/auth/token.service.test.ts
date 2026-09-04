import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jwtVerify, importSPKI } from 'jose';
import { decodeSessionId, TokenService } from './token.service.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    secrets: {
      auth: {
        jwtIssuer: 'https://auth.test',
        jwtAudience: 'audiobook-api',
        jwtPrivateKey: privateKey,
      },
    },
    authPolicy: { accessTokenTtlSeconds: 900 },
    ...overrides,
  };
}

describe('TokenService.issueAccessToken', () => {
  it('signs a token JwtAuthGuard-shaped verification accepts, carrying sub/tenant_id/roles/scopes/sid', async () => {
    const service = new TokenService(makeConfig() as never);
    const { accessToken, expiresIn } = await service.issueAccessToken({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roles: ['TENANT_OWNER'],
      scopes: ['read'],
      sessionId: 'session-1',
    });

    expect(expiresIn).toBe(900);
    const key = await importSPKI(publicKey, 'RS256');
    const { payload } = await jwtVerify(accessToken, key, {
      issuer: 'https://auth.test',
      audience: 'audiobook-api',
    });
    expect(payload.sub).toBe('user-1');
    expect(payload.tenant_id).toBe('tenant-1');
    expect(payload.roles).toEqual(['TENANT_OWNER']);
    expect(payload.scopes).toEqual(['read']);
    expect(payload.sid).toBe('session-1');
    expect(payload.jti).toBeTruthy();
  });

  it('fails closed with a clear error when issuance is not configured', async () => {
    const service = new TokenService({ secrets: {}, authPolicy: { accessTokenTtlSeconds: 900 } } as never);
    await expect(
      service.issueAccessToken({ sub: 'u', tenantId: 't', roles: [], scopes: [], sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'AUTH_ISSUANCE_NOT_CONFIGURED' });
  });
});

describe('decodeSessionId', () => {
  it('reads back the sid claim from an already-issued token without re-verifying', async () => {
    const service = new TokenService(makeConfig() as never);
    const { accessToken } = await service.issueAccessToken({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roles: [],
      scopes: [],
      sessionId: 'session-42',
    });
    expect(decodeSessionId(accessToken)).toBe('session-42');
  });
});
