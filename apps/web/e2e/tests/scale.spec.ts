import { expect, test } from '@playwright/test';
import { resetApi, signIn } from '../support';

/**
 * Scale and performance (Phase 9 rules 139, 140, 141, 149, 150).
 *
 * The API stand-in serves a 120-chapter, 60-character project, which is what
 * makes these assertions about windowing real rather than theoretical.
 */

test.beforeEach(async () => {
  await resetApi();
});

test('a 120-chapter book renders a windowed list, not 120 rows', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects/book-scripted/chapters');

  await expect(page.getByText('120 chapters', { exact: false })).toBeVisible();

  const rendered = await page.locator('ul li a[href*="/chapters/"]').count();
  // Windowed: a viewport's worth plus overscan, nowhere near 120.
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(60);

  // And the list is genuinely scrollable to the end.
  const region = page.getByRole('region', { name: /chapters/ });
  await region.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect(page.getByText('Chapter 120')).toBeVisible();
});

test('a 60-character cast stays searchable and assignable', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects/book-scripted/characters');

  await expect(page.getByRole('heading', { name: 'Cast' })).toBeVisible();
  await page.getByLabel('Filter characters by name').fill('Captain');
  await expect(page.getByText('Captain Reyes')).toBeVisible();
  await expect(page.getByText('Character 3')).toHaveCount(0);
});

test('the studio does not poll aggressively', async ({ page }) => {
  // Rule 44 / 88. The `read` rate-limit bucket is per user and per tenant.
  await signIn(page);
  const progressCalls: number[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/progress')) progressCalls.push(Date.now());
  });

  await page.goto('/projects/book-ready');
  await page.waitForTimeout(12_000);

  // A completed book has nothing running, so it must not be polled quickly.
  expect(progressCalls.length).toBeLessThanOrEqual(3);
});

test('the initial page weight stays modest', async ({ page }) => {
  // Rule 151: a bundle budget that fails loudly beats a bundle nobody watches.
  await signIn(page);

  let scriptBytes = 0;
  page.on('response', (response) => {
    if (response.url().includes('/_next/static/') && response.url().endsWith('.js')) {
      scriptBytes += Number(response.headers()['content-length'] ?? 0);
    }
  });

  await page.goto('/projects');
  await page.waitForLoadState('networkidle');

  // Generous, but it fails if a heavyweight dependency is added carelessly.
  expect(scriptBytes).toBeLessThan(1_500_000);
});
