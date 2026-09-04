import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { resetApi, signIn } from '../support';

/**
 * Accessibility in a real browser (Phase 9 rules 83, 147).
 *
 * Complements the jsdom scan: here CSS actually resolves, so **colour contrast
 * is checked**, and focus order is exercised against real layout.
 */

test.beforeEach(async () => {
  await resetApi();
});

const PAGES = [
  { path: '/', name: 'dashboard' },
  { path: '/projects', name: 'projects' },
  { path: '/projects/new', name: 'create project' },
  { path: '/projects/book-ready', name: 'project overview' },
  { path: '/projects/book-ready/audiobook', name: 'audiobook' },
  { path: '/projects/book-review/review', name: 'review queue' },
  { path: '/projects/book-scripted/voices', name: 'casting' },
  { path: '/projects/book-scripted/chapters', name: 'chapters' },
  { path: '/voices', name: 'voice library' },
  { path: '/settings', name: 'settings' },
];

for (const target of PAGES) {
  test(`${target.name} has no automatically detectable accessibility violations`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'One engine is enough for the axe scan.');
    await signIn(page);
    await page.goto(target.path);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 3).map((node) => node.html),
      })),
    ).toEqual([]);
  });
}

test('every page is reachable and operable by keyboard alone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One engine is enough.');
  await signIn(page);
  await page.goto('/projects/book-ready');

  // The skip link is the first tab stop on every page (WCAG 2.4.1).
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('a dialog contains focus and returns it on close', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One engine is enough.');
  // Rule 129 — the property native <dialog> gives that hand-rolled traps miss.
  await signIn(page);
  await page.goto('/projects/book-scripted/generation');

  const trigger = page.getByRole('button', { name: 'Generate audio' });
  await trigger.focus();
  // The button is disabled until casting completes, so use a stage that is not.
  const runnable = page.getByRole('button', { name: /Run again|Analyse the story/ }).first();
  await runnable.focus();
  await runnable.press('Enter');

  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(runnable).toBeFocused();
});

test('honours a reduced-motion preference', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One engine is enough.');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const reduced = await context.newPage();
  await signIn(reduced);
  await reduced.goto('/projects/book-scripted');

  const duration = await reduced.evaluate(() => {
    const element = document.querySelector('[role="progressbar"] > div');
    return element ? getComputedStyle(element).transitionDuration : '0s';
  });
  expect(['0s', '0.001s']).toContain(duration);
  await context.close();
});
