import { describe, expect, it } from 'vitest';
import { buildApiConfig, buildWorkerConfig, ConfigValidationError } from './index.js';

const validApiEnv = {
  SERVICE_NAME: 'api',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/audiobook',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'audiobook-dev',
  STORAGE_ACCESS_KEY_ID: 'minioadmin',
  STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  AUTH_JWT_ISSUER: 'https://auth.local',
  AUTH_JWT_AUDIENCE: 'audiobook-api',
  AUTH_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
  METRICS_SERVICE_TOKEN: 'test-token',
};

describe('buildApiConfig', () => {
  it('fails fast when required configuration is missing', () => {
    expect(() => buildApiConfig({})).toThrow(ConfigValidationError);
  });

  it('never falls back to an unsafe default for secrets', () => {
    const { DATABASE_URL: _omit, ...rest } = validApiEnv;
    expect(() => buildApiConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('accepts a public key even when AUTH_JWT_JWKS_URL is present but empty', () => {
    // `.env.example` ships `AUTH_JWT_JWKS_URL=`. An empty string must be
    // treated as "not provided", not as a satisfied alternative — otherwise
    // following the documented setup makes the API refuse to start.
    const config = buildApiConfig({ ...validApiEnv, AUTH_JWT_JWKS_URL: '' });
    expect(config.secrets.auth?.jwtJwksUrl).toBeUndefined();
    expect(config.secrets.auth?.jwtPublicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('still rejects a config where neither JWKS URL nor public key is usable', () => {
    expect(() =>
      buildApiConfig({ ...validApiEnv, AUTH_JWT_PUBLIC_KEY: '   ', AUTH_JWT_JWKS_URL: '' }),
    ).toThrow(ConfigValidationError);
  });

  it('exposes the §14.3 rate-limit buckets with usable defaults', () => {
    const config = buildApiConfig(validApiEnv);
    expect(config.rateLimit.enabled).toBe(true);
    expect(config.rateLimit.windowSeconds).toBeGreaterThan(0);
    // Expensive work must never be more permissive than plain reads.
    expect(config.rateLimit.buckets.expensive).toBeLessThan(config.rateLimit.buckets.read);
    expect(config.rateLimit.buckets.upload).toBeLessThan(config.rateLimit.buckets.read);
  });

  it('builds a well-shaped config split into app/http/secrets/models', () => {
    const config = buildApiConfig(validApiEnv);
    expect(config.app.serviceName).toBe('api');
    expect(config.secrets.databaseUrl).toContain('postgresql://');
    expect(config.http.port).toBe(3000);
    expect(config.models).toEqual({ _phase1Placeholder: true });
  });
});

describe('buildWorkerConfig', () => {
  it('does not require auth configuration (workers never verify end-user JWTs)', () => {
    const {
      AUTH_JWT_ISSUER: _i,
      AUTH_JWT_AUDIENCE: _a,
      AUTH_JWT_PUBLIC_KEY: _k,
      ...rest
    } = validApiEnv;
    const config = buildWorkerConfig(rest);
    expect(config.app.serviceName).toBe('api');
    expect(config.worker.concurrency).toBe(1);
  });
});
