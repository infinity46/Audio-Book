// `server-only` is a build-time guard, not runtime behaviour. Under vitest the
// modules that import it are exercised directly, so the guard is a no-op.
export {};
