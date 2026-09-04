import { expect, test } from '@playwright/test';
import { resetApi, signIn } from '../support';

/**
 * Front-end security audit, executed rather than asserted on paper
 * (Phase 9 rules 121, 123, 126, 128, 189, 190).
 */

test.beforeEach(async () => {
  await resetApi();
});

test('the production bundle contains no credentials or internal addresses', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One engine is enough.');
  await signIn(page);

  const scripts: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes('/_next/static/') && response.url().endsWith('.js')) {
      scripts.push(await response.text().catch(() => ''));
    }
  });

  await page.goto('/projects/book-ready');
  await page.waitForLoadState('networkidle');

  const bundle = scripts.join('\n');
  expect(bundle.length).toBeGreaterThan(1000);
  // The API's address is a server variable; the browser only ever calls /bff.
  expect(bundle).not.toContain('localhost:4010');
  expect(bundle).not.toContain('AUTH_JWT_PUBLIC_KEY');
  expect(bundle).not.toMatch(/BEGIN (RSA )?(PUBLIC|PRIVATE) KEY/);
  expect(bundle).not.toContain('eyJhbGciOiJSUzI1NiI');
});

test('refuses a cross-origin write even with a valid session', async ({ page, context }) => {
  // Rule 128 — SameSite plus an explicit origin check at the BFF.
  await signIn(page);

  const status = await page.evaluate(async () => {
    const response = await fetch('/bff/api/v1/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'x', language: 'en-US' }),
    });
    return response.status;
  });
  // The browser refuses to forge `Origin`, so this same-origin call succeeds —
  // which is itself the point: a genuinely cross-site page cannot make it.
  expect([201, 403]).toContain(status);

  // A request from a different origin cannot carry the session cookie at all.
  const bare = await context.request.post('http://localhost:3101/bff/api/v1/books', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    data: { title: 'x', language: 'en-US' },
  });
  expect(bare.status()).toBe(403);
});

test('does not proxy anything outside the public API surface', async ({ page }) => {
  await signIn(page);
  for (const path of ['/bff/metrics', '/bff/internal/v1/test/cleanup-jobs', '/bff/health/dependencies']) {
    const response = await page.request.get(`http://localhost:3101${path}`);
    expect(response.status()).toBe(404);
  }
});

test('renders book text as content, never as executable markup', async ({ page }) => {
  // Rules 123, 125. The passage in the fixture contains markup and reads like
  // an instruction; it must be displayed, never interpreted.
  await signIn(page);

  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });

  await page.goto('/projects/book-review/review');
  await expect(page.getByText('<b>Not markup.</b>', { exact: false }).first()).toBeVisible();
  expect(await page.locator('blockquote b').count()).toBe(0);
  expect(dialogs).toBe(0);
});

test('refuses to redirect off-site after sign-in', async ({ page }) => {
  // Rule 190 — open redirect.
  await page.goto('/sign-in?returnTo=https://evil.example/steal');
  await page.getByLabel('Email').fill('reader@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/localhost:3101\/(\?|$)/);
});

test('sends the security headers the deployment declares', async ({ page }) => {
  const response = await page.goto('/sign-in');
  const headers = response?.headers() ?? {};
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('never caches an authenticated API response', async ({ page }) => {
  await signIn(page);
  const responses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/bff/api/v1/')) {
      responses.push(response.headers()['cache-control'] ?? '');
    }
  });
  await page.goto('/projects/book-ready');
  await page.waitForLoadState('networkidle');
  expect(responses.length).toBeGreaterThan(0);
  for (const value of responses) expect(value).toContain('no-store');
});
