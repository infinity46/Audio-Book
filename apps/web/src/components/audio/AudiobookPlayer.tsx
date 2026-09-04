'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioPlayer } from './AudioPlayer';
import { useSignedAudio } from '@/lib/hooks/useSignedAudio';
import { Button } from '@/components/ui/Button';
import { ScrollRegion } from '@/components/ui/ScrollRegion';
import { cn } from '@/lib/cn';
import { formatTimecode } from '@/lib/format';
import type { Audiobook } from '@/lib/api/types';

/**
 * The full-book player (Phase 9 rules 60–63, 91, 141, 178, 179).
 *
 * **One artifact, one signed URL, chapter navigation by offset.** The audiobook
 * is a single file with a chapter manifest, so selecting a chapter seeks to its
 * `start_ms` rather than loading a different file. That is what makes rule 179
 * true by construction — moving between chapters does not reload or reset
 * anything — and it is why a ten-hour book costs one request: object storage
 * serves the byte ranges the element asks for as it plays (rule 141). Nothing
 * is fetched until play is pressed.
 *
 * Playback position is remembered per audiobook in `localStorage`. That is the
 * right home for it: it is a per-viewer convenience, there is no API field for
 * playback position, and inventing a server-side one would be a feature the
 * backend does not have (rule 61 — "according to product policy").
 */

const POSITION_KEY_PREFIX = 'audiobook-studio:position:';

function readStoredPosition(audiobookId: string): number | null {
  try {
    const raw = localStorage.getItem(`${POSITION_KEY_PREFIX}${audiobookId}`);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    // Private windows and blocked site data throw on access, rather than
    // returning null. The player still works — it just starts at zero.
    return null;
  }
}

function writeStoredPosition(audiobookId: string, positionMs: number): void {
  try {
    localStorage.setItem(`${POSITION_KEY_PREFIX}${audiobookId}`, String(Math.round(positionMs)));
  } catch {
    /* nothing to do — the position simply is not remembered */
  }
}

export function AudiobookPlayer({
  bookId,
  audiobook,
}: {
  bookId: string;
  audiobook: Audiobook;
}) {
  const audio = useSignedAudio(
    `/api/v1/books/${bookId}/audiobooks/${audiobook.id}/access-urls`,
  );

  const chapters = useMemo(
    () => [...audiobook.chapter_manifest].sort((a, b) => a.order_index - b.order_index),
    [audiobook.chapter_manifest],
  );

  const [positionMs, setPositionMs] = useState(0);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);

  // Restore on mount only; afterwards the element drives position.
  useEffect(() => {
    const stored = readStoredPosition(audiobook.id);
    if (stored !== null) {
      setSeekTarget(stored);
      setPositionMs(stored);
    }
    setResumed(true);
  }, [audiobook.id]);

  const handleTimeUpdate = useCallback(
    (ms: number) => {
      setPositionMs(ms);
      // Throttled to whole seconds: a write per timeupdate event would be ~4
      // storage writes a second for no benefit.
      if (Math.floor(ms / 1000) !== Math.floor(positionMs / 1000)) {
        writeStoredPosition(audiobook.id, ms);
      }
    },
    [audiobook.id, positionMs],
  );

  const currentIndex = useMemo(() => {
    let index = 0;
    for (let i = 0; i < chapters.length; i += 1) {
      if (positionMs >= (chapters[i]?.start_ms ?? 0)) index = i;
      else break;
    }
    return index;
  }, [chapters, positionMs]);

  const goToChapter = (index: number) => {
    const chapter = chapters[index];
    if (!chapter) return;
    setSeekTarget(chapter.start_ms);
    setPositionMs(chapter.start_ms);
    writeStoredPosition(audiobook.id, chapter.start_ms);
  };

  const currentChapter = chapters[currentIndex] ?? null;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[12px] text-[var(--text-muted)]">Now playing</p>
        <p className="mt-0.5 text-sm font-semibold text-[var(--text-primary)]" aria-live="polite">
          {currentChapter?.title ?? `Chapter ${currentIndex + 1}`}
        </p>
      </div>

      {resumed ? (
        <AudioPlayer
          audio={audio}
          title={audiobook.metadata.title ?? 'the audiobook'}
          durationMsHint={audiobook.duration_ms}
          onTimeUpdate={handleTimeUpdate}
          startAtMs={seekTarget}
          extraControls={
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Previous chapter"
                onClick={() => goToChapter(Math.max(0, currentIndex - 1))}
                disabled={currentIndex === 0}
                disabledReason={currentIndex === 0 ? 'This is the first chapter.' : undefined}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M11 3.5v9L5 8z" fill="currentColor" />
                  <rect x="3.5" y="3.5" width="1.5" height="9" fill="currentColor" />
                </svg>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Next chapter"
                onClick={() => goToChapter(Math.min(chapters.length - 1, currentIndex + 1))}
                disabled={currentIndex >= chapters.length - 1}
                disabledReason={
                  currentIndex >= chapters.length - 1 ? 'This is the last chapter.' : undefined
                }
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M5 3.5v9L11 8z" fill="currentColor" />
                  <rect x="11" y="3.5" width="1.5" height="9" fill="currentColor" />
                </svg>
              </Button>
            </div>
          }
        />
      ) : null}

      {chapters.length > 0 ? (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Chapters
          </h3>
          <ScrollRegion
            label="Chapter list"
            className="max-h-72 rounded-[var(--radius-control)] border border-[var(--border-subtle)]"
          >
            <ul className="divide-y divide-[var(--border-subtle)]">
            {chapters.map((chapter, index) => (
              <li key={chapter.chapter_id}>
                <button
                  type="button"
                  onClick={() => goToChapter(index)}
                  aria-current={index === currentIndex ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                    index === currentIndex
                      ? 'bg-[var(--accent-soft)]'
                      : 'hover:bg-[var(--panel-raised)]',
                  )}
                >
                  <span className="w-7 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                    {chapter.title ?? `Chapter ${index + 1}`}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                    {formatTimecode(chapter.start_ms)}
                  </span>
                </button>
              </li>
              ))}
            </ul>
          </ScrollRegion>
        </div>
      ) : null}
    </div>
  );
}
