'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BFF_PREFIX } from '@/lib/api/client';

/**
 * Live project updates over SSE (Phase 9 rules 43, 45, 46, 143).
 *
 * `GET /api/v1/books/{id}/events` tails the durable outbox, so this is the
 * transport the Phase 8 architecture specifies — no second realtime system is
 * introduced. Three properties of that contract shape this hook:
 *
 *  1. **The stream is a notification channel, not a source of truth**
 *     (`api-usage-guide.md` §7). Events carry identifiers and small facts only —
 *     never text, audio, or URLs. So an event never *updates* the cache: it
 *     invalidates it, and the subsequent read re-derives state from the
 *     database. That is also what makes a missed event harmless, which is what
 *     makes reload (rule 45) and multi-tab (rule 46) safe by construction.
 *
 *  2. **Resumption is the browser's job.** `EventSource` replays
 *     `Last-Event-ID` on reconnect automatically, and the BFF forwards that
 *     header. A `stream.resync` frame means the id fell outside the replay
 *     window; the documented response is to re-read progress, which is exactly
 *     what a full invalidation does.
 *
 *  3. **The credential is never in the URL.** `EventSource` cannot set an
 *     `Authorization` header — which is why the stream goes through this app's
 *     same-origin BFF, where the httpOnly cookie is exchanged for the bearer.
 *     Putting a token in a query parameter is called out as forbidden because
 *     URLs are logged.
 *
 * Invalidation is **coalesced** rather than routed per event type. A book being
 * generated emits thousands of `tts.chunk_completed` frames; mapping each to a
 * key set would be a second, hand-maintained copy of the event vocabulary that
 * could drift from `event-contracts.md` §12. One debounced subtree invalidation
 * is both cheaper and impossible to get wrong.
 */

const COALESCE_MS = 800;

export type StreamState = 'idle' | 'connecting' | 'open' | 'error';

export interface EventStreamResult {
  state: StreamState;
  /** True only while frames can actually arrive. Drives the polling backstop. */
  streaming: boolean;
  lastEventAt: number | null;
}

export function useBookEventStream(
  bookId: string | undefined,
  options: { enabled?: boolean } = {},
): EventStreamResult {
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('idle');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bookId || !enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setState('idle');
      return;
    }

    setState('connecting');
    const source = new EventSource(`${BFF_PREFIX}/api/v1/books/${bookId}/events`, {
      withCredentials: true,
    });

    const scheduleInvalidate = () => {
      setLastEventAt(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // Everything hanging off this book, plus the job list, which is keyed
        // separately because it is also filtered tenant-wide.
        void queryClient.invalidateQueries({ queryKey: ['books', bookId] });
        void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      }, COALESCE_MS);
    };

    source.onopen = () => setState('open');
    source.onmessage = scheduleInvalidate;
    // Named frames do not reach `onmessage`; the outbox emits every domain
    // event under its own `event:` name, so this is the path that actually
    // fires in production.
    source.addEventListener('stream.resync', scheduleInvalidate);
    for (const name of TRACKED_EVENT_PREFIXES) {
      source.addEventListener(name, scheduleInvalidate);
    }
    source.onerror = () => {
      // `EventSource` reconnects on its own with `Last-Event-ID`; surfacing
      // 'error' only downgrades the polling backstop back to its fast rate,
      // which is precisely the recovery behaviour rule 143 asks for.
      setState((current) => (current === 'open' ? 'error' : 'connecting'));
    };

    return () => {
      if (timer.current) clearTimeout(timer.current);
      source.close();
      setState('idle');
    };
  }, [bookId, enabled, queryClient]);

  return { state, streaming: state === 'open', lastEventAt };
}

/**
 * The `event-contracts.md` §12 names this app listens for by name.
 *
 * Unknown names are still handled: the SSE `message` handler covers unnamed
 * frames, and any event this list misses simply means one extra poll interval
 * of latency, never a wrong screen — the stream is not the source of truth.
 */
const TRACKED_EVENT_PREFIXES = [
  'book.created',
  'book.status_changed',
  'ingestion.started',
  'ingestion.page_parsed',
  'ingestion.completed',
  'ingestion.failed',
  'analysis.started',
  'analysis.scene_completed',
  'analysis.completed',
  'character.registered',
  'character.merged',
  'director.started',
  'director.chunk_generated',
  'director.completed',
  'director.failed',
  'tts.started',
  'tts.chunk_completed',
  'tts.chunk_failed',
  'tts.completed',
  'assembly.started',
  'assembly.chapter_completed',
  'assembly.completed',
  'assembly.failed',
  'audiobook.ready',
  'job.created',
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'job.dead_lettered',
] as const;
