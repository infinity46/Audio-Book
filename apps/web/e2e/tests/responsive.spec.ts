import { expect, test } from '@playwright/test';
import { resetApi, signIn } from '../support';

/**
 * Responsive behaviour (Phase 9 rules 86, 87, 105, 146).
 *
 * The studio is desktop-first, but nothing may break on a phone — and in
 * particular the page must never scroll sideways, which is the failure a wide
 * table causes when it is not contained.
 */

test.beforeEach(async () => {
  await resetApi();
});

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test(`the project workspace works at ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'This test sets its own viewport.');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signIn(page);
    await page.goto('/projects/book-ready');

    await expect(page.getByRole('heading', { name: 'The Long Voyage' })).toBeVisible();

    // Nothing may cause a horizontal page scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('the primary navigation collapses on a phone and still works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/');

  const menu = page.getByRole('button', { name: 'Open menu' });
  await expect(menu).toBeVisible();
  await menu.click();

  const nav = page.getByRole('navigation', { name: 'Primary' }).last();
  await nav.getByRole('link', { name: 'Voices' }).click();
  await expect(page).toHaveURL(/\/voices/);
});

test('a wide table scrolls inside itself, not the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/projects/book-failed/jobs');

  await expect(page.getByRole('region', { name: 'Job history' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
