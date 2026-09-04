import { defineConfig, devices } from '@playwright/test';
import { TEST_PUBLIC_KEY_PEM, TEST_ISSUER, TEST_AUDIENCE } from './e2e/fixtures/test-key';

/**
 * End-to-end suite (Phase 9 rules 133–148).
 *
 * Runs the **production build** of the studio (`next build && next start`),
 * not the dev server — rule 185 is explicit that a passing dev server is not
 * evidence. The API is a stateful stand-in (`e2e/mock-api`) rather than the
 * real stack, because the real one needs Postgres, Redis, MinIO and a GPU;
 * what is under test here is the studio, and it talks to the mock over the
 * same HTTP contract.
 *
 * The browser matrix is Chromium, Firefox, and WebKit — Chrome, Firefox, and
 * Safari respectively (rule 148). Edge shares Chromium's engine, so it is
 * covered by the Chromium project rather than by a fourth identical run.
 */

const WEB_PORT = 3101;
const MOCK_API_PORT = 4010;

export default defineConfig({
  testDir: './e2e/tests',
  /*
   * Serial by necessity, not by preference: the API stand-in holds one shared,
   * mutable state — the same property that makes it a faithful stand-in for a
   * stateful backend. Parallel workers would have tests resetting each other's
   * books mid-flight, which is a fixture problem masquerading as flakiness.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Rule 146: the studio is desktop-first but must not break on a phone.
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],

  webServer: [
    {
      command: 'node --import tsx e2e/mock-api/server.ts',
      port: MOCK_API_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { MOCK_API_PORT: String(MOCK_API_PORT) },
    },
    {
      command: 'pnpm build && pnpm exec next start --port ' + WEB_PORT,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        AUDIOBOOK_API_URL: `http://localhost:${MOCK_API_PORT}`,
        AUTH_JWT_ISSUER: TEST_ISSUER,
        AUTH_JWT_AUDIENCE: TEST_AUDIENCE,
        AUTH_JWT_PUBLIC_KEY: TEST_PUBLIC_KEY_PEM,
        // Local HTTP: the session cookie cannot carry `Secure`, and therefore
        // cannot use the `__Host-` prefix either.
        SESSION_COOKIE_SECURE: 'false',
        WEB_PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
        NODE_ENV: 'production',
      },
    },
  ],
});
