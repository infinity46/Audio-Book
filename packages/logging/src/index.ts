import pino, { type Logger as PinoLogger } from 'pino';
import {
  getCorrelationContext,
  runWithCorrelation,
  type CorrelationContext,
} from './correlation.js';
import { redactSensitiveFields } from './redaction.js';

export { runWithCorrelation, getCorrelationContext, type CorrelationContext };
export { redactSensitiveFields };

export interface LoggerOptions {
  serviceName: string;
  environment: string;
  logLevel: string;
  /** Set false in production; pretty-printing is a development convenience only. */
  pretty?: boolean;
}

/**
 * Structured logger. Every line carries: timestamp, level, service,
 * environment, and — whenever available from the current correlation
 * context — correlation_id, job_id, worker_id. Objects passed as the first
 * arg are passed through redactSensitiveFields first so book text/prompts/
 * embeddings can never leak into logs even by accident.
 */
export function createLogger(options: LoggerOptions): PinoLogger {
  const base = pino({
    level: options.logLevel,
    base: { service: options.serviceName, environment: options.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: options.pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'iso' } }
      : undefined,
    mixin() {
      const ctx = getCorrelationContext();
      if (!ctx) return {};
      const mixed: Record<string, string> = { correlation_id: ctx.correlationId };
      if (ctx.causationId) mixed.causation_id = ctx.causationId;
      if (ctx.jobId) mixed.job_id = ctx.jobId;
      if (ctx.workerId) mixed.worker_id = ctx.workerId;
      return mixed;
    },
    hooks: {
      logMethod(inputArgs, method) {
        const [first, ...rest] = inputArgs;
        if (first && typeof first === 'object') {
          return method.apply(this, [redactSensitiveFields(first), ...rest] as Parameters<
            typeof method
          >);
        }
        return method.apply(this, inputArgs);
      },
    },
  });
  return base;
}

export type Logger = PinoLogger;

/**
 * Convenience for logging a caught error with its taxonomy code.
 *
 * Emits a safe diagnostic alongside the code: the error's own message, its
 * class, and — for errors with no taxonomy code, i.e. the unexpected ones —
 * the stack and the cause chain. Without these an operator sees only
 * `UNKNOWN_ERROR` and has nothing to debug from, which is over-redaction
 * rather than safety: nothing here is book text, a credential, or a signed
 * URL, and every field still passes through `redactSensitiveFields` on the
 * way out (see `createLogger`'s `logMethod` hook).
 *
 * Client-facing responses are unaffected — the API's error envelope never
 * includes any of this (api-specification.md §8.2). This is the server-side
 * log only.
 */
export function logError(logger: Logger, err: unknown, message?: string): void {
  const hasCode =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string';
  const errorCode = hasCode ? (err as { code: string }).code : 'UNKNOWN_ERROR';
  const errorMessage = err instanceof Error ? err.message : 'Unknown error';

  const fields: Record<string, unknown> = {
    error_code: errorCode,
    error_message: errorMessage,
  };
  if (err instanceof Error) {
    fields.error_class = err.constructor.name;
    // An error carrying a taxonomy code is expected and self-describing; an
    // uncoded one is a genuine surprise and is the case that needs a stack.
    if (!hasCode) {
      fields.error_stack = err.stack;
      if (err.cause instanceof Error) {
        fields.error_cause = `${err.cause.constructor.name}: ${err.cause.message}`;
      }
    }
  }

  logger.error(fields, message ?? errorMessage);
}
