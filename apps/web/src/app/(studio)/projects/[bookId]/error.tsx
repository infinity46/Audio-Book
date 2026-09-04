'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';

/**
 * Studio-segment error boundary (rule 153).
 *
 * Contains a crash to the content area: the shell, its navigation, and every
 * other route stay usable. Only `digest` is surfaced — a hash, carrying no
 * message, stack, or path (rule 156).
 */
export default function StudioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Studio route error', error.digest ?? error.message);
  }, [error]);

  return (
    <Panel className="p-8 text-center">
      <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
        This page could not be displayed
      </h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
        Something in this view failed. Nothing about your projects has changed — everything is
        stored on the server.
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
        <Link href="/projects">
          <Button>All projects</Button>
        </Link>
      </div>
    </Panel>
  );
}
