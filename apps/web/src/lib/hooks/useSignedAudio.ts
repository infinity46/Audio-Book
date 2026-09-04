'use client';

import { useCallback, useRef, useState } from 'react';
import { post } from '@/lib/api/client';
import type { AccessUrl } from '@/lib/api/types';

/**
 * On-demand signed audio URLs (Phase 9 rules 29, 63–65, 91, 93).
 *
 * `POST .../access-urls` mints a short-lived credential against object storage.
 * Four properties follow, and this hook exists to honour all four:
 *
 *  - **No bytes pass through the application.** The URL is handed to an
 *    `<audio>` element, which fetches from storage directly. A twenty-hour
 *    audiobook is never buffered by this app or by the API.
 *  - **Range requests are object storage's job**, so seeking works without any
 *    range handling here — `206` comes from storage, not from the API.
 *  - **URLs expire** (300s default, 900s cap) and are explicitly not cacheable,
 *    so they are minted per playback and re-minted on expiry, never stored.
 *  - **Minting is audited** as `ACCESS_URL_MINTED`, so it is not something to
 *    do speculatively for every row in a list. Nothing is minted until the user
 *    presses play (rule 91).
 */
export interface SignedAudio {
  url: string | null;
  loading: boolean;
  error: unknown;
  /** Mints a URL, reusing one that is still comfortably in date. */
  resolve: () => Promise<string | null>;
  /** Discards the cached URL so the next `resolve` mints a fresh one. */
  invalidate: () => void;
}

/** Re-mint this far before the stated expiry rather than racing it. */
const EXPIRY_SAFETY_MS = 20_000;

export function useSignedAudio(accessUrlPath: string | null): SignedAudio {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const expiresAt = useRef<number>(0);
  const inFlight = useRef<Promise<string | null> | null>(null);

  const invalidate = useCallback(() => {
    setUrl(null);
    expiresAt.current = 0;
  }, []);

  const resolve = useCallback(async (): Promise<string | null> => {
    if (!accessUrlPath) return null;
    if (url && Date.now() < expiresAt.current - EXPIRY_SAFETY_MS) return url;
    // Two controls asking at once must not mint two credentials.
    if (inFlight.current) return inFlight.current;

    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const access = await post<AccessUrl>(accessUrlPath, {
          body: { disposition: 'INLINE' },
        });
        expiresAt.current = Date.parse(access.expires_at);
        setUrl(access.url);
        return access.url;
      } catch (err) {
        setError(err);
        return null;
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = request;
    return request;
  }, [accessUrlPath, url]);

  return { url, loading, error, resolve, invalidate };
}
