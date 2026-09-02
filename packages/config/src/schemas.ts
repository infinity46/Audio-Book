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

/**
 * An env var that is present but empty (`FOO=`) is indistinguishable from one
 * that was never set, and treating them differently is a reliable source of
 * "it works on my machine". Normalizes both to `undefined`.
 */
const emptyStringAsUndefined = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

// Left as a plain ZodObject (not `.refine()`d here) so it stays mergeable —
// `.refine()` returns a ZodEffects, which z.object(...).merge() cannot
// accept. The "one of JWKS URL or public key" cross-field rule is applied
// once, after composition, in index.ts's apiEnvSchema.
export const authEnvSchema = z.object({
  AUTH_JWT_ISSUER: z.string().min(1, 'AUTH_JWT_ISSUER is required'),
  AUTH_JWT_AUDIENCE: z.string().min(1, 'AUTH_JWT_AUDIENCE is required'),
  // An unset env var and one set to the empty string must mean the same
  // thing. `.env.example` ships both of these as empty (`AUTH_JWT_JWKS_URL=`),
  // so without this normalization an operator who supplies a public key still
  // presents an empty-string JWKS URL — which used to satisfy `??` and make
  // the cross-field check in index.ts ignore the public key entirely, so the
  // service could not start at all.
  AUTH_JWT_JWKS_URL: emptyStringAsUndefined,
  AUTH_JWT_PUBLIC_KEY: emptyStringAsUndefined,
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

/**
 * Rate-limit buckets from api-specification.md §14.3. The buckets themselves
 * are contract; the numbers are explicitly `configuration` in the spec, so
 * they live here as env-tunable defaults rather than being frozen in code.
 *
 * Defaults are deliberately generous enough not to impede normal interactive
 * use and strict enough to bound abuse; they are starting points to be tuned
 * against measured traffic, not researched limits.
 *
 * `stream` (SSE) is absent because this API exposes no SSE endpoint yet, and
 * `auth` is absent because the auth endpoints themselves are not implemented
 * (see the JwtAuthGuard docstring). Adding either means adding its bucket.
 */
export const rateLimitEnvSchema = z.object({
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Window length shared by every bucket below. */
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** All GET endpoints. */
  RATE_LIMIT_READ_PER_WINDOW: z.coerce.number().int().positive().default(300),
  /** POST/PATCH/DELETE on metadata. */
  RATE_LIMIT_WRITE_PER_WINDOW: z.coerce.number().int().positive().default(60),
  /** Upload-session creation and finalization. */
  RATE_LIMIT_UPLOAD_PER_WINDOW: z.coerce.number().int().positive().default(20),
  /** Pipeline-starting endpoints: ingestion, analysis, director, tts, assembly, previews. */
  RATE_LIMIT_EXPENSIVE_PER_WINDOW: z.coerce.number().int().positive().default(10),
  /** Signed-URL minting. */
  RATE_LIMIT_ACCESS_URL_PER_WINDOW: z.coerce.number().int().positive().default(60),
});

/** Tunable resource limits/behavior for the ingestion pipeline (task §63/§75/§118). Defaults match @audio-book/ingestion's own DEFAULT_INGESTION_CONFIG. */
export const ingestionEnvSchema = z.object({
  INGESTION_MAX_FILE_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),
  INGESTION_MAX_PAGES: z.coerce.number().int().positive().default(3000),
  INGESTION_MAX_EPUB_ENTRY_COUNT: z.coerce.number().int().positive().default(10_000),
  INGESTION_MAX_EPUB_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024),
  INGESTION_MAX_EPUB_ENTRY_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  INGESTION_PARSER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  INGESTION_NORMALIZATION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  INGESTION_DEHYPHENATE: z.coerce.boolean().default(true),
  INGESTION_HEADER_FOOTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  INGESTION_MAX_IMAGE_DIMENSION_PX: z.coerce.number().int().positive().default(10_000),
  INGESTION_MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(100_000_000),
  INGESTION_MAX_IMAGE_PAGES: z.coerce.number().int().positive().default(3000),
  INGESTION_OCR_LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
});

/**
 * OCR engine selection/tuning (task §25/§29/§119 follow-up: TesseractOcrProvider).
 * `OCR_LANG_PATH` left unset means tesseract.js's default network fetch of
 * trained-data files is allowed; infra/docker/worker-cpu.Dockerfile sets it
 * to a build-time-baked local directory by default so the shipped image
 * makes no such runtime call unless explicitly reconfigured otherwise.
 */
export const ocrEnvSchema = z.object({
  OCR_ENABLED: z.coerce.boolean().default(true),
  OCR_LANGUAGE: z.string().min(1).default('eng'),
  OCR_LANG_PATH: z.string().optional(),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  OCR_RASTER_SCALE: z.coerce.number().positive().default(2.0),
});
