'use client';

import { Button } from './Button';
import { formatCount } from '@/lib/format';

/**
 * Cursor pagination (Phase 9 rule 118 — server-side, always).
 *
 * The API is forward-cursor only: `page.prev_cursor` is `null` on every
 * collection this app reads, and a cursor is opaque and must never be
 * constructed or parsed (`api-usage-guide.md` §3). "Previous" is therefore
 * driven by a stack of cursors the caller has already *visited*, not by a
 * cursor the client invents — see `useCursorPagination`.
 */
export function Pagination({
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
  loading = false,
  shownCount,
  total,
  label,
}: {
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  loading?: boolean;
  shownCount: number;
  /** `page.total` is `null` on most collections — the UI must not invent one. */
  total?: number | null;
  label: string;
}) {
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-5 py-3"
      aria-label={label}
    >
      <p className="text-[13px] tabular-nums text-[var(--text-muted)]">
        {total !== null && total !== undefined
          ? `Showing ${formatCount(shownCount)} of ${formatCount(total)}`
          : `Showing ${formatCount(shownCount)}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onPrevious}
          disabled={!hasPrevious || loading}
          disabledReason={!hasPrevious ? 'You are on the first page.' : undefined}
        >
          Previous
        </Button>
        <Button
          size="sm"
          onClick={onNext}
          disabled={!hasNext || loading}
          disabledReason={!hasNext ? 'There are no more results.' : undefined}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
