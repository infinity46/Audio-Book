import { z } from 'zod';
import {
  appEnvSchema,
  authEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  ingestionEnvSchema,
  metricsEnvSchema,
  ocrEnvSchema,
  outboxPublisherEnvSchema,
  rateLimitEnvSchema,
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

/** api-specification.md §14.3 buckets. Limits are per window, per identity. */
export interface RateLimitSection {
  enabled: boolean;
  windowSeconds: number;
  buckets: {
    read: number;
    write: number;
    upload: number;
    expensive: number;
    access_url: number;
  };
}

export interface IngestionSection {
  maxFileSizeBytes: number;
  maxPages: number;
  maxEpubEntryCount: number;
  maxEpubUncompressedBytes: number;
  maxEpubEntryUncompressedBytes: number;
  parserTimeoutMs: number;
  normalizationTimeoutMs: number;
  dehyphenate: boolean;
  headerFooterConfidenceThreshold: number;
  maxImageDimensionPx: number;
  maxImagePixels: number;
  maxImagePages: number;
  ocrLowConfidenceThreshold: number;
}

/** OCR engine selection/tuning — see schemas.ts ocrEnvSchema for the "why" on OCR_LANG_PATH. */
export interface OcrSection {
  enabled: boolean;
  language: string;
  langPath?: string;
  timeoutMs: number;
  rasterScale: number;
}

export interface ApiConfig {
  app: AppSection;
  http: HttpSection;
  secrets: SecretsSection;
  models: ModelsSection;
  databasePool: DatabasePoolSection;
  outboxPublisher: OutboxPublisherSection;
  rateLimit: RateLimitSection;
}

export interface WorkerConfig {
  app: AppSection;
  secrets: Omit<SecretsSection, 'auth'>;
  models: ModelsSection;
  databasePool: DatabasePoolSection;
  worker: { concurrency: number };
  ingestion: IngestionSection;
  ocr: OcrSection;
}

const apiEnvSchema = appEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(authEnvSchema)
  .merge(httpEnvSchema)
  .merge(metricsEnvSchema)
  .merge(outboxPublisherEnvSchema)
  .merge(rateLimitEnvSchema)
  // `||`, not `??`: an empty-string JWKS URL must fall through to the public
  // key rather than short-circuiting as "provided" (see authEnvSchema).
  .refine((v) => Boolean(v.AUTH_JWT_JWKS_URL || v.AUTH_JWT_PUBLIC_KEY), {
    message: 'one of AUTH_JWT_JWKS_URL or AUTH_JWT_PUBLIC_KEY must be set',
    path: ['AUTH_JWT_JWKS_URL'],
  });

const workerEnvSchemaComposed = appEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(metricsEnvSchema)
  .merge(workerEnvSchema)
  .merge(ingestionEnvSchema)
  .merge(ocrEnvSchema);

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
    rateLimit: {
      enabled: parsed.RATE_LIMIT_ENABLED,
      windowSeconds: parsed.RATE_LIMIT_WINDOW_SECONDS,
      buckets: {
        read: parsed.RATE_LIMIT_READ_PER_WINDOW,
        write: parsed.RATE_LIMIT_WRITE_PER_WINDOW,
        upload: parsed.RATE_LIMIT_UPLOAD_PER_WINDOW,
        expensive: parsed.RATE_LIMIT_EXPENSIVE_PER_WINDOW,
        access_url: parsed.RATE_LIMIT_ACCESS_URL_PER_WINDOW,
      },
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
    ingestion: {
      maxFileSizeBytes: parsed.INGESTION_MAX_FILE_SIZE_BYTES,
      maxPages: parsed.INGESTION_MAX_PAGES,
      maxEpubEntryCount: parsed.INGESTION_MAX_EPUB_ENTRY_COUNT,
      maxEpubUncompressedBytes: parsed.INGESTION_MAX_EPUB_UNCOMPRESSED_BYTES,
      maxEpubEntryUncompressedBytes: parsed.INGESTION_MAX_EPUB_ENTRY_UNCOMPRESSED_BYTES,
      parserTimeoutMs: parsed.INGESTION_PARSER_TIMEOUT_MS,
      normalizationTimeoutMs: parsed.INGESTION_NORMALIZATION_TIMEOUT_MS,
      dehyphenate: parsed.INGESTION_DEHYPHENATE,
      headerFooterConfidenceThreshold: parsed.INGESTION_HEADER_FOOTER_CONFIDENCE_THRESHOLD,
      maxImageDimensionPx: parsed.INGESTION_MAX_IMAGE_DIMENSION_PX,
      maxImagePixels: parsed.INGESTION_MAX_IMAGE_PIXELS,
      maxImagePages: parsed.INGESTION_MAX_IMAGE_PAGES,
      ocrLowConfidenceThreshold: parsed.INGESTION_OCR_LOW_CONFIDENCE_THRESHOLD,
    },
    ocr: {
      enabled: parsed.OCR_ENABLED,
      language: parsed.OCR_LANGUAGE,
      langPath: parsed.OCR_LANG_PATH,
      timeoutMs: parsed.OCR_TIMEOUT_MS,
      rasterScale: parsed.OCR_RASTER_SCALE,
    },
  };
}
