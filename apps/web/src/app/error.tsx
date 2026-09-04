'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * Top-level error boundary (Phase 9 rule 153).
 *
 * Route-segment boundaries live alongside the pages that can fail; this is the
 * last resort so a crash in one component never leaves a blank document.
 * `digest` is the only server-side identifier Next exposes here, and it is a
 * hash — no message, no stack, nothing to leak (rule 156).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Left as a console record deliberately: no telemetry provider is
    // configured in this deployment, and rule 155 forbids shipping content to
    // one that is not. See docs/application/frontend-architecture.md §8.
    console.error('Unhandled error in Audiobook Studio', error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        This page could not be displayed. Your project data is stored on the server and is
        unaffected.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-[11px] text-[var(--text-muted)]">
          Reference {error.digest}
        </p>
      ) : null}
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button onClick={() => (window.location.href = '/')}>Go to dashboard</Button>
      </div>
    </main>
  );
}
