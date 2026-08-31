import { IngestionTimeoutError } from './errors.js';

/** Races `promise` against a timeout, raising the shared IngestionTimeoutError so parsers/OCR fail cleanly instead of hanging the worker (task §76). */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new IngestionTimeoutError({ message: `${label} exceeded ${timeoutMs}ms.` }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
