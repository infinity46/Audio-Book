/**
 * Ingestion-specific error taxonomy (task spec §127), layered on
 * @audio-book/errors' AppError so the API's exception filter and error
 * envelope handling apply unchanged. Each code carries a fixed
 * retryable/terminal classification per event-contracts.md §21.2 — a
 * deterministic/content problem (corrupted file, unsupported format) is
 * terminal; a resource/environment problem (timeout) is retryable.
 */
import { AppError, type AppErrorOptions } from '@audio-book/errors';

type IngestionErrorOptions = Omit<AppErrorOptions, 'category' | 'code' | 'retryable'>;

export class UnsupportedFormatError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({
      ...options,
      code: 'UNSUPPORTED_FORMAT',
      category: 'UNSUPPORTED_MEDIA',
      retryable: false,
    });
  }
}

export class InvalidFileError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'INVALID_FILE', category: 'VALIDATION', retryable: false });
  }
}

export class CorruptedFileError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'CORRUPTED_FILE', category: 'VALIDATION', retryable: false });
  }
}

export class FileTooLargeError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'FILE_TOO_LARGE', category: 'PAYLOAD_TOO_LARGE', retryable: false });
  }
}

export class SecurityViolationError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'SECURITY_VIOLATION', category: 'VALIDATION', retryable: false });
  }
}

export class ParserFailedError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'PARSER_FAILED', category: 'INTERNAL', retryable: true });
  }
}

export class NormalizationFailedError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'NORMALIZATION_FAILED', category: 'INTERNAL', retryable: true });
  }
}

export class StructureDetectionFailedError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({
      ...options,
      code: 'STRUCTURE_DETECTION_FAILED',
      category: 'INTERNAL',
      retryable: true,
    });
  }
}

export class OutputValidationFailedError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'OUTPUT_VALIDATION_FAILED', category: 'INTERNAL', retryable: false });
  }
}

export class IngestionTimeoutError extends AppError {
  constructor(options: IngestionErrorOptions) {
    super({ ...options, code: 'TIMEOUT', category: 'DEPENDENCY_FAILURE', retryable: true });
  }
}

export function isTerminalIngestionError(err: unknown): boolean {
  return (
    err instanceof UnsupportedFormatError ||
    err instanceof InvalidFileError ||
    err instanceof CorruptedFileError ||
    err instanceof FileTooLargeError ||
    err instanceof SecurityViolationError ||
    err instanceof OutputValidationFailedError
  );
}
