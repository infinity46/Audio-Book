'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/States';
import { cn } from '@/lib/cn';
import { formatTimecode } from '@/lib/format';
import type { SignedAudio } from '@/lib/hooks/useSignedAudio';

/**
 * The studio's audio player (Phase 9 rules 58, 63, 85, 91, 180).
 *
 * Accessibility is the load-bearing part here:
 *  - every control is a real `<button>` or `<input>` with an explicit label;
 *  - the scrubber is an `<input type="range">`, so arrow keys, Home/End and
 *    Page Up/Down all work without a line of custom key handling, and it
 *    announces its position through `aria-valuetext` as a timecode rather than
 *    as a raw number of seconds;
 *  - the transport is a `group` with an accessible name, so the whole player is
 *    navigable as one unit.
 *
 * Loading is deliberately lazy: `preload="none"` and no signed URL is minted
 * until the user presses play. Nothing about a ten-hour audiobook is fetched by
 * opening a page (rules 91, 141).
 */

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export interface AudioPlayerProps {
  audio: SignedAudio;
  /** Accessible name for the transport, e.g. the chapter title. */
  title: string;
  /** Server-reported duration, used before metadata loads. */
  durationMsHint?: number | null;
  /** Called with the element's position, for cross-chapter continuity. */
  onTimeUpdate?: (positionMs: number) => void;
  onEnded?: () => void;
  /** Seek here once the source is ready (resume position). */
  startAtMs?: number | null;
  compact?: boolean;
  className?: string;
  /** Rendered next to the transport — previous/next chapter, for instance. */
  extraControls?: React.ReactNode;
}

export function AudioPlayer({
  audio,
  title,
  durationMsHint,
  onTimeUpdate,
  onEnded,
  startAtMs,
  compact = false,
  className,
  extraControls,
}: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement>(null);
  const groupId = useId();
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(durationMsHint ?? null);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [seeking, setSeeking] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(startAtMs ?? null);

  // A new source means a new track: reset transport state rather than carrying
  // the previous chapter's position into it.
  useEffect(() => {
    pendingSeek.current = startAtMs ?? null;
    setPositionMs(startAtMs ?? 0);
    setDurationMs(durationMsHint ?? null);
    setMediaError(null);
  }, [audio.url, startAtMs, durationMsHint]);

  const togglePlay = useCallback(async () => {
    const element = ref.current;
    if (!element) return;
    if (playing) {
      element.pause();
      return;
    }
    setMediaError(null);
    // Mint only now — pressing play is what authorises fetching the bytes.
    const source = await audio.resolve();
    if (!source) return;
    if (element.src !== source) element.src = source;
    try {
      await element.play();
    } catch {
      setMediaError('Playback could not start. The audio link may have expired.');
    }
  }, [audio, playing]);

  const handleError = useCallback(() => {
    // An expired signed URL is the overwhelmingly common cause; discarding it
    // means the next press mints a fresh one rather than replaying a dead link.
    audio.invalidate();
    setPlaying(false);
    setMediaError('This audio could not be played. Try again to fetch a fresh link.');
  }, [audio]);

  const effectiveDuration = durationMs ?? durationMsHint ?? null;
  const sliderMax = effectiveDuration ?? 0;
  const sliderValue = seeking ?? positionMs;

  return (
    <div className={cn('w-full', className)}>
      <audio
        ref={ref}
        // Nothing is fetched until play. This is what keeps a chapter list from
        // opening dozens of connections.
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onError={handleError}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds)) setDurationMs(seconds * 1000);
          if (pendingSeek.current !== null) {
            event.currentTarget.currentTime = pendingSeek.current / 1000;
            pendingSeek.current = null;
          }
        }}
        onTimeUpdate={(event) => {
          const ms = event.currentTarget.currentTime * 1000;
          setPositionMs(ms);
          onTimeUpdate?.(ms);
        }}
      >
        <track kind="captions" />
      </audio>

      {mediaError || audio.error ? (
        <ErrorState
          error={audio.error ?? new Error(mediaError ?? '')}
          compact
          className="mb-3"
          onRetry={() => {
            audio.invalidate();
            setMediaError(null);
            void togglePlay();
          }}
        />
      ) : null}

      <div
        role="group"
        aria-labelledby={groupId}
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--panel-sunken)]',
          compact ? 'px-3 py-2' : 'px-4 py-3',
        )}
      >
        <span id={groupId} className="sr-only">
          Audio player for {title}
        </span>

        {extraControls}

        <Button
          variant="primary"
          size={compact ? 'sm' : 'md'}
          onClick={() => void togglePlay()}
          loading={audio.loading}
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          className="!rounded-full !px-0 aspect-square"
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
              <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M5 3.5v9l8-4.5z" fill="currentColor" />
            </svg>
          )}
        </Button>

        <span className="font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">
          {formatTimecode(sliderValue)}
        </span>

        <div className="min-w-[8rem] flex-1">
          <label htmlFor={`${groupId}-seek`} className="sr-only">
            Seek within {title}
          </label>
          <input
            id={`${groupId}-seek`}
            type="range"
            min={0}
            max={sliderMax || 1}
            step={1000}
            value={sliderValue}
            disabled={!effectiveDuration}
            aria-valuetext={`${formatTimecode(sliderValue)} of ${formatTimecode(effectiveDuration)}`}
            onChange={(event) => setSeeking(Number(event.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
            className="w-full accent-[var(--accent)]"
          />
        </div>

        <span className="font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
          {formatTimecode(effectiveDuration)}
        </span>

        <div className="flex items-center gap-2">
          <label htmlFor={`${groupId}-rate`} className="sr-only">
            Playback speed for {title}
          </label>
          <select
            id={`${groupId}-rate`}
            value={rate}
            onChange={(event) => {
              const next = Number(event.target.value);
              setRate(next);
              if (ref.current) ref.current.playbackRate = next;
            }}
            className="rounded-[var(--radius-control)] border border-[var(--border-default)] bg-[var(--panel)] px-1.5 py-1 font-mono text-[12px] text-[var(--text-secondary)]"
          >
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>

          <label htmlFor={`${groupId}-volume`} className="sr-only">
            Volume for {title}
          </label>
          <input
            id={`${groupId}-volume`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-valuetext={`${Math.round(volume * 100)} percent`}
            onChange={(event) => {
              const next = Number(event.target.value);
              setVolume(next);
              if (ref.current) ref.current.volume = next;
            }}
            className="hidden w-20 accent-[var(--accent)] sm:block"
          />
        </div>
      </div>
    </div>
  );

  function commitSeek() {
    if (seeking === null) return;
    if (ref.current) ref.current.currentTime = seeking / 1000;
    setPositionMs(seeking);
    setSeeking(null);
  }
}
