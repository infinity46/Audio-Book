import { z } from 'zod';

/**
 * Every schema piece below is a slice of environment configuration. Services
 * compose only the pieces they need (see buildApiConfig / buildWorkerConfig).
 * Nothing here has an unsafe default — anything security- or
 * correctness-relevant is required, and a missing/invalid value fails fast
 * at startup rather than silently falling back.
 */

export const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const appEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  SERVICE_NAME: z.string().min(1, 'SERVICE_NAME is required'),
  LOG_LEVEL: logLevelSchema.default('info'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .regex(/^rediss?:\/\//, 'REDIS_URL must be a redis:// or rediss:// connection string'),
});

export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().min(1, 'STORAGE_ENDPOINT is required'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().min(1, 'STORAGE_BUCKET is required'),
  STORAGE_ACCESS_KEY_ID: z.string().min(1, 'STORAGE_ACCESS_KEY_ID is required'),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1, 'STORAGE_SECRET_ACCESS_KEY is required'),
  STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
});

// Left as a plain ZodObject (not `.refine()`d here) so it stays mergeable —
// `.refine()` returns a ZodEffects, which z.object(...).merge() cannot
// accept. The "one of JWKS URL or public key" cross-field rule is applied
// once, after composition, in index.ts's apiEnvSchema.
export const authEnvSchema = z.object({
  AUTH_JWT_ISSUER: z.string().min(1, 'AUTH_JWT_ISSUER is required'),
  AUTH_JWT_AUDIENCE: z.string().min(1, 'AUTH_JWT_AUDIENCE is required'),
  AUTH_JWT_JWKS_URL: z.string().optional(),
  AUTH_JWT_PUBLIC_KEY: z.string().optional(),
});

export const httpEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  BODY_SIZE_LIMIT_BYTES: z.coerce.number().int().positive().default(512_000),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
});

export const metricsEnvSchema = z.object({
  METRICS_SERVICE_TOKEN: z.string().min(1, 'METRICS_SERVICE_TOKEN is required'),
});

export const workerEnvSchema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
});

export const outboxPublisherEnvSchema = z.object({
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
});
