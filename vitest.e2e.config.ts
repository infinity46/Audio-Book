import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite: boots the compiled services and drives them over real
 * HTTP. Slower and heavier than `vitest.integration.config.ts`, and requires
 * `pnpm -r run build` to have run, so it is a separate target rather than
 * part of the default test run.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file boots its own API (and sometimes a worker) on its own port;
    // running them concurrently would multiply load on the shared Postgres,
    // Redis, and MinIO for no gain.
    fileParallelism: false,
  },
});
