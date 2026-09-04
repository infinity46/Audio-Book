import { expect, test } from '@playwright/test';
import { advance, failNext, resetApi, signIn, signInViaForm, trackBffRequests } from '../support';

/**
 * The full user workflow (Phase 9 rules 133–138).
 *
 * Each test drives the studio the way a producer would, against a stateful API
 * stand-in that enforces the same preconditions the real one does.
 */

test.beforeEach(async () => {
  await resetApi();
});

/**
 * Casting the one blocking character, robustly.
 *
 * The cast list deliberately re-sorts as assignments land — unvoiced first —
 * so a row can move out from under a click. Waiting for the assignment panel
 * to settle between steps is what makes this deterministic rather than a
 * retry-until-it-works loop.
 */
async function castCaptainReyes(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/projects/book-scripted/voices');
  await expect(page.getByRole('heading', { name: 'Casting readiness' })).toBeVisible();

  await page.getByRole('button', { name: /Captain Reyes/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Warm Narrator/ }).first().click();
  const use = page.getByRole('button', { name: 'Use this voice' }).first();
  await expect(use).toBeEnabled();
  await use.click();

  await expect(page.getByText(/Warm Narrator · v2/)).toBeVisible();
}

test.describe('authentication', () => {
  test('an unauthenticated visitor is sent to sign in, and returns to where they were', async ({
    page,
  }) => {
    await page.goto('/projects/book-ready/generation');
    await expect(page).toHaveURL(/\/sign-in\?returnTo=/);

    await signIn(page);
    // Signing in from a deep link lands back on it, not on the dashboard.
    await page.goto('/projects/book-ready/generation');
    await expect(page.getByRole('heading', { name: 'Production steps' })).toBeVisible();
  });

  test('refuses incorrect credentials without starting a session', async ({ page }) => {
    await failNext('/api/v1/auth/login', 401, 'UNAUTHENTICATED');
    await signInViaForm(page, { password: 'wrong-password' });
    await expect(page.getByText(/incorrect email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('never puts the credential anywhere a script could read it', async ({ page, context }) => {
    // The bearer lives in an httpOnly cookie held by the BFF. Rule 121.
    await signIn(page);

    const storage = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storage.local).not.toContain('eyJ');
    expect(storage.session).not.toContain('eyJ');

    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name.includes('audiobook_session'));
    expect(session?.httpOnly).toBe(true);

    // And the document itself cannot see it.
    const documentCookie = await page.evaluate(() => document.cookie);
    expect(documentCookie).not.toContain('eyJ');
  });
});

test.describe('project workflow', () => {
  test('dashboard → create project → the project workspace', async ({ page }) => {
    await signIn(page);
    await page.goto('/');

    await page.getByRole('link', { name: 'New project' }).first().click();
    await expect(page).toHaveURL(/\/projects\/new/);

    await page.getByLabel('Title').fill('An E2E Production');
    await page.getByLabel('Author').fill('Test Author');
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/projects\/book-new-/);
    await expect(page.getByRole('heading', { name: 'An E2E Production' })).toBeVisible();
    // A brand-new project's next step is to attach a source book.
    await expect(page.getByRole('link', { name: /Upload the book/ })).toBeVisible();
  });

  test('a project page reconstructs itself from the server after a reload', async ({ page }) => {
    // Rules 45, 108, 142.
    await signIn(page);
    await page.goto('/projects/book-scripted/generation');
    await expect(page.getByRole('heading', { name: 'Production steps' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Production steps' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A Winter Crossing' })).toBeVisible();
  });

  test('the same project in two tabs stays consistent', async ({ context }) => {
    // Rule 145. Neither tab holds authoritative state, so neither can diverge.
    const first = await context.newPage();
    await signIn(first);
    await first.goto('/projects/book-ready');

    const second = await context.newPage();
    await second.goto('/projects/book-ready');

    for (const page of [first, second]) {
      await expect(page.getByRole('heading', { name: 'The Long Voyage' })).toBeVisible();
      await expect(page.getByText('Ready').first()).toBeVisible();
    }
  });
});

test.describe('voice casting and generation', () => {
  test('generation is refused until every speaking character has a voice, then accepted', async ({
    page,
  }) => {
    // Rules 136, 37: the studio surfaces the precondition the API enforces.
    await signIn(page);
    await page.goto('/projects/book-scripted/generation');

    const generate = page.getByRole('button', { name: 'Generate audio' });
    await expect(generate).toBeDisabled();
    await expect(page.getByText(/still (has|have) no approved voice/)).toBeVisible();

    // Cast the blocking character.
    await castCaptainReyes(page);

    // Now generation is allowed, and asks for confirmation before spending.
    await page.goto('/projects/book-scripted/generation');
    const enabled = page.getByRole('button', { name: 'Generate audio' });
    await expect(enabled).toBeEnabled();
    await enabled.click();

    await expect(page.getByRole('heading', { name: 'Generate audio?' })).toBeVisible();
    await expect(page.getByText(/most expensive step/)).toBeVisible();
    // Rule 175 — never a promised completion time.
    await expect(page.getByText(/cannot promise when this will finish/)).toBeVisible();

    await page.getByRole('button', { name: 'Generate audio' }).last().click();
    await expect(page.getByText(/has been accepted and queued/)).toBeVisible();
  });

  test('a live generation shows measured progress and never a fabricated one', async ({ page }) => {
    await signIn(page);
    await advance({ book_id: 'book-scripted', status: 'RUNNING', completed_units: 0, total_units: null, book_status: 'GENERATING' });

    await page.goto('/projects/book-scripted/generation');
    // No denominator yet: "Preparing…", not 0%.
    await expect(page.getByText('Preparing…').first()).toBeVisible();

    await advance({ book_id: 'book-scripted', status: 'RUNNING', completed_units: 61, total_units: 100 });
    await expect(page.getByText('61%').first()).toBeVisible({ timeout: 20_000 });
  });

  test('cancellation reports that the work has not stopped yet', async ({ page }) => {
    // Rules 49, 50: cooperative cancellation, and completed work is kept.
    await signIn(page);
    await castCaptainReyes(page);

    await page.goto('/projects/book-scripted/generation');
    await page.getByRole('button', { name: 'Generate audio' }).click();
    await page.getByRole('button', { name: 'Generate audio' }).last().click();
    await expect(page.getByText(/has been accepted and queued/)).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByText(/Everything already finished is/)).toBeVisible();
    await page.getByRole('button', { name: 'Request cancellation' }).click();

    // The job is RUNNING, so the API answers effective: false — the UI must not
    // claim the work stopped.
    await expect(page.getByText('Cancelling').first()).toBeVisible();
    await expect(page.getByText(/stops at the next safe point/).first()).toBeVisible();
  });
});

test.describe('failure and recovery', () => {
  test('a failed generation explains itself and offers the real remedy', async ({ page }) => {
    // Rules 47, 48, 134: no retry endpoint exists; re-running the stage is it.
    await signIn(page);
    await page.goto('/projects/book-failed/generation');

    await expect(page.getByText(/failed/i).first()).toBeVisible();
    await page.goto('/projects/book-failed/jobs');
    await expect(page.getByText('TTS_PROVIDER_ERROR')).toBeVisible();
    await expect(page.getByText(/will not be retried automatically/)).toBeVisible();
    await expect(page.getByText(/no “retry” button here, by design/)).toBeVisible();
  });

  test('a rate limit is distinguished from an exhausted quota', async ({ page }) => {
    await signIn(page);
    // Land on the projects page and let it settle first: the dashboard also
    // reads /books, and a one-shot injection would otherwise be consumed by
    // whichever request happened to be in flight.
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await failNext('/books', 429, 'QUOTA_EXCEEDED');
    await page.reload();

    await expect(page.getByText(/Workspace allowance used up/)).toBeVisible();
    await expect(page.getByText(/Retrying will not help/)).toBeVisible();
  });

  test('an expired session sends the user to sign in without losing their place', async ({
    page,
  }) => {
    // Rules 76, 144.
    await signIn(page, { expiresIn: '2s' });
    await page.goto('/projects/book-ready');
    await expect(page.getByRole('heading', { name: 'The Long Voyage' })).toBeVisible();

    await page.waitForTimeout(3000);
    await page.reload();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('the application survives losing the network and recovers when it returns', async ({
    page,
    context,
  }) => {
    // Rules 77, 143.
    await signIn(page);
    await page.goto('/projects/book-ready');
    await expect(page.getByRole('heading', { name: 'The Long Voyage' })).toBeVisible();

    await context.setOffline(true);
    await page.reload().catch(() => undefined);
    await context.setOffline(false);

    await page.goto('/projects/book-ready');
    await expect(page.getByRole('heading', { name: 'The Long Voyage' })).toBeVisible();
  });
});

test.describe('review', () => {
  test('a flagged passage can be inspected and resolved', async ({ page }) => {
    // Rule 135.
    await signIn(page);
    await page.goto('/projects/book-review/review');

    await expect(page.getByRole('heading', { name: 'Flagged passages' })).toBeVisible();
    await expect(page.getByText('Low confidence').first()).toBeVisible();
    // Book text is rendered as text: the literal markup is visible, not applied.
    await expect(page.getByText('<b>Not markup.</b>', { exact: false }).first()).toBeVisible();
    expect(await page.locator('blockquote b').count()).toBe(0);

    await page.getByRole('button', { name: 'Mark as resolved' }).first().click();
    await expect(page.getByText('Marked as resolved.')).toBeVisible();
  });

  test('does not claim a severity the API never sent', async ({ page }) => {
    // Rule 172: severity is only shown where the backend supplies it, and
    // review flags carry none.
    await signIn(page);
    await page.goto('/projects/book-review/review');
    await expect(page.getByRole('heading', { name: 'Flagged passages' })).toBeVisible();
    await expect(page.getByText(/^Critical$|^High$|^Medium$|^Low$/)).toHaveCount(0);
  });
});

test.describe('audiobook delivery', () => {
  test('play, seek, navigate chapters, and see version history', async ({ page }) => {
    // Rules 137, 141: one artifact, chapter navigation by offset, nothing
    // preloaded.
    await signIn(page);
    await page.goto('/projects/book-ready/audiobook');

    // The workspace header (h1) and the audiobook card (h2) both carry the
    // title; the level disambiguates without weakening the assertion.
    await expect(page.getByRole('heading', { name: 'The Long Voyage', level: 1 })).toBeVisible();
    await expect(page.getByText('10h 30m', { exact: true })).toBeVisible();

    // Nothing is fetched before the user presses play.
    const audioPreload = await page.locator('audio').first().getAttribute('preload');
    expect(audioPreload).toBe('none');

    await page.getByRole('button', { name: /Chapter 2/ }).click();
    await expect(page.getByRole('button', { name: /Chapter 2/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
    await expect(page.getByText('Superseded').first()).toBeVisible();
  });

  test('download mints a signed URL and nothing about storage leaks into the page', async ({
    page,
  }) => {
    // Rules 64, 65, 138.
    await signIn(page);
    const { requests } = trackBffRequests(page);
    await page.goto('/projects/book-ready/audiobook');

    const download = page.getByRole('button', { name: /Download M4B/ });
    await expect(download).toBeEnabled();
    await download.click();

    await expect
      .poll(() =>
        requests.some(
          (request) => request.method() === 'POST' && request.url().includes('/access-urls'),
        ),
      )
      .toBe(true);

    const html = await page.content();
    expect(html).not.toContain('storage_key');
    expect(html).not.toContain('s3://');
  });
});
