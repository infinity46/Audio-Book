import { z } from 'zod';
import {
  appEnvSchema,
  authEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  metricsEnvSchema,
  outboxPublisherEnvSchema,
  redisEnvSchema,
  storageEnvSchema,
  workerEnvSchema,
  type LogLevel,
  type NodeEnv,
} from './schemas.js';

export * from './schemas.js';

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid configuration — refusing to start:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Parses `env` against `schema`. Throws ConfigValidationError (never a silent
 * fallback) when required configuration is missing or invalid. Callers
 * should let this throw crash the process at startup — configuration is not
 * something to recover from at runtime.
 */
export function loadConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }
  return result.data as z.infer<TSchema>;
}

/** Application identity/behavior — safe to log, safe to check into config (not secrets). */
export interface AppSection {
  serviceName: string;
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
}

/** Deployment-environment-shaped knobs (ports, limits) — not secret, environment-specific. */
export interface HttpSection {
  port: number;
  bodySizeLimitBytes: number;
  corsAllowedOrigins: string[];
}

/** Credentials and connection strings — never logged, never defaulted. */
export interface SecretsSection {
  databaseUrl: string;
  redisUrl: string;
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  auth?: {
    jwtIssuer: string;
    jwtAudience: string;
    jwtJwksUrl?: string;
    jwtPublicKey?: string;
  };
  metricsServiceToken: string;
}

/** Reserved for future model/provider references (Director LLM, TTS engines) — not populated in Phase 1. */
export interface ModelsSection {
  readonly _phase1Placeholder: true;
}

export interface DatabasePoolSection {
  min: number;
  max: number;
}

export interface OutboxPublisherSection {
  pollIntervalMs: number;
  batchSize: number;
}

export interface ApiConfig {
  app: AppSection;
  http: HttpSection;
  secrets: SecretsSection;
  models: ModelsSection;
  databasePool: DatabasePoolSection;
  outboxPublisher: OutboxPublisherSection;
}

export interface WorkerConfig {
  app: AppSection;
  secrets: Omit<SecretsSection, 'auth'>;
  models: ModelsSection;
  databasePool: DatabasePoolSection;
  worker: { concurrency: number };
}

const apiEnvSchema = appEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(authEnvSchema)
  .merge(httpEnvSchema)
  .merge(metricsEnvSchema)
  .merge(outboxPublisherEnvSchema)
  .refine((v) => Boolean(v.AUTH_JWT_JWKS_URL ?? v.AUTH_JWT_PUBLIC_KEY), {
    message: 'one of AUTH_JWT_JWKS_URL or AUTH_JWT_PUBLIC_KEY must be set',
    path: ['AUTH_JWT_JWKS_URL'],
  });

const workerEnvSchemaComposed = appEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(metricsEnvSchema)
  .merge(workerEnvSchema);

const MODELS_PLACEHOLDER: ModelsSection = { _phase1Placeholder: true };

export function buildApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = loadConfig(apiEnvSchema, env);
  return {
    app: {
      serviceName: parsed.SERVICE_NAME,
      nodeEnv: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
    },
    http: {
      port: parsed.PORT,
      bodySizeLimitBytes: parsed.BODY_SIZE_LIMIT_BYTES,
      corsAllowedOrigins: parsed.CORS_ALLOWED_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    secrets: {
      databaseUrl: parsed.DATABASE_URL,
      redisUrl: parsed.REDIS_URL,
      storage: {
        endpoint: parsed.STORAGE_ENDPOINT,
        region: parsed.STORAGE_REGION,
        bucket: parsed.STORAGE_BUCKET,
        accessKeyId: parsed.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: parsed.STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: parsed.STORAGE_FORCE_PATH_STYLE,
      },
      auth: {
        jwtIssuer: parsed.AUTH_JWT_ISSUER,
        jwtAudience: parsed.AUTH_JWT_AUDIENCE,
        jwtJwksUrl: parsed.AUTH_JWT_JWKS_URL,
        jwtPublicKey: parsed.AUTH_JWT_PUBLIC_KEY,
      },
      metricsServiceToken: parsed.METRICS_SERVICE_TOKEN,
    },
    models: MODELS_PLACEHOLDER,
    databasePool: { min: parsed.DATABASE_POOL_MIN, max: parsed.DATABASE_POOL_MAX },
    outboxPublisher: {
      pollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
      batchSize: parsed.OUTBOX_BATCH_SIZE,
    },
  };
}

export function buildWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = loadConfig(workerEnvSchemaComposed, env);
  return {
    app: {
      serviceName: parsed.SERVICE_NAME,
      nodeEnv: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
    },
    secrets: {
      databaseUrl: parsed.DATABASE_URL,
      redisUrl: parsed.REDIS_URL,
      storage: {
        endpoint: parsed.STORAGE_ENDPOINT,
        region: parsed.STORAGE_REGION,
        bucket: parsed.STORAGE_BUCKET,
        accessKeyId: parsed.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: parsed.STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: parsed.STORAGE_FORCE_PATH_STYLE,
      },
      metricsServiceToken: parsed.METRICS_SERVICE_TOKEN,
    },
    models: MODELS_PLACEHOLDER,
    databasePool: { min: parsed.DATABASE_POOL_MIN, max: parsed.DATABASE_POOL_MAX },
    worker: { concurrency: parsed.WORKER_CONCURRENCY },
  };
}
