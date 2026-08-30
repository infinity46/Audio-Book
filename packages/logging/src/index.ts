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

/** Convenience for logging a caught error with its taxonomy code, when available. */
export function logError(logger: Logger, err: unknown, message?: string): void {
  const errorCode =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : 'UNKNOWN_ERROR';
  const errorMessage = err instanceof Error ? err.message : 'Unknown error';
  logger.error({ error_code: errorCode }, message ?? errorMessage);
}
