'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, isApiError, isNetworkError } from '@/lib/api/errors';

/**
 * Server-state configuration (Phase 9 rules 78, 93–97).
 *
 * The retry policy is the important part. `error-handling.md` §9 rule 4 allows
 * an automatic retry **only** when the API says `retryable: true` — and the
 * transport layer (`api/client.ts`) already applies that, with backoff and
 * `Retry-After`, for safe methods. Query-level retry is therefore off: a second
 * retry policy layered on the first would multiply request volume against a
 * per-tenant rate-limit bucket for no additional resilience.
 *
 * Mutations never retry at all. A stage command is expensive, and repeating one
 * on the client's own initiative is exactly what rule 78 forbids.
 */

const AUTH_REDIRECT_CODES = new Set(['UNAUTHENTICATED']);

export function AppQueryProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            // A session that expired mid-workflow sends the user to sign in
            // *with a return path*, so their place is not lost (rule 76).
            if (isApiError(error) && AUTH_REDIRECT_CODES.has(error.code)) {
              const returnTo =
                typeof window !== 'undefined'
                  ? `${window.location.pathname}${window.location.search}`
                  : '/';
              router.replace(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
            }
          },
        }),
        defaultOptions: {
          queries: {
            // The transport already retried what was worth retrying.
            retry: false,
            // Project state changes because a worker did something, not
            // because the user focused the window; the poll and the stream
            // handle freshness. Refetching on every focus in a studio with
            // several tabs open is pure request volume.
            refetchOnWindowFocus: false,
            // ...but a reconnect genuinely means state may have moved on while
            // we were blind (rule 143).
            refetchOnReconnect: true,
            staleTime: 10_000,
            gcTime: 5 * 60_000,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Shared predicate for "should this surface offer a Try again button?". */
export function isRecoverable(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  return error instanceof ApiError && error.retryable;
}
