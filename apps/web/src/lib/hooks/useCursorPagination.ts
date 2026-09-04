'use client';

import { useCallback, useState } from 'react';

/**
 * Forward-cursor pagination with a working "Previous" (rule 118).
 *
 * The API returns `prev_cursor: null` on every collection, and a cursor is
 * opaque — `api-usage-guide.md` §3 forbids constructing or parsing one. So
 * "Previous" is served from a stack of cursors this session has **already been
 * given**, which is a client-side memory of server-issued values, not an
 * invented cursor. Going back beyond the stack is simply not offered.
 */
export function useCursorPagination() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);

  const next = useCallback(
    (nextCursor: string | null) => {
      if (!nextCursor) return;
      setHistory((stack) => [...stack, cursor]);
      setCursor(nextCursor);
    },
    [cursor],
  );

  const previous = useCallback(() => {
    setHistory((stack) => {
      if (stack.length === 0) return stack;
      setCursor(stack[stack.length - 1] ?? null);
      return stack.slice(0, -1);
    });
  }, []);

  /** Any filter change must restart pagination — a cursor is filter-specific. */
  const reset = useCallback(() => {
    setCursor(null);
    setHistory([]);
  }, []);

  return { cursor, hasPrevious: history.length > 0, next, previous, reset };
}
