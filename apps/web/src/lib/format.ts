/**
 * Display formatting.
 *
 * The one rule that matters here comes from `api-usage-guide.md` §7: **`null`
 * is not `0`**. A `null` denominator means the server cannot yet know the
 * total — rendering it as `0%` would be a fabricated measurement. Every
 * formatter below returns an explicit "not known yet" string instead.
 */

/** `0.58` → `"58%"`. `null` → `null`, never `"0%"`. */
export function formatProgress(progress: number | null | undefined): string | null {
  if (progress === null || progress === undefined || Number.isNaN(progress)) return null;
  const clamped = Math.max(0, Math.min(1, progress));
  // Never round up to 100% before the work is actually complete: a bar reading
  // "100%" while a stage is still RUNNING is the classic progress-bar lie.
  const percent = clamped * 100;
  if (percent > 99 && percent < 100) return '99%';
  return `${Math.round(percent)}%`;
}

/** Milliseconds → `"9h 12m"` / `"4m 03s"`. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Milliseconds → `"1:04:03"` / `"4:03"`, for a transport display. */
export function formatTimecode(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined).format(value);
}

/**
 * `"2026-08-27T15:04:03Z"` → `"3 hours ago"`.
 *
 * Rendered inside a `<time>` element with the absolute value in `title`, so the
 * precise timestamp is never lost to the relative one (rule 104).
 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const deltaSeconds = Math.round((then - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 45) return rtf.format(Math.round(deltaSeconds), 'second');
  if (absolute < 45 * 60) return rtf.format(Math.round(deltaSeconds / 60), 'minute');
  if (absolute < 22 * 3600) return rtf.format(Math.round(deltaSeconds / 3600), 'hour');
  if (absolute < 26 * 86400) return rtf.format(Math.round(deltaSeconds / 86400), 'day');
  if (absolute < 320 * 86400) return rtf.format(Math.round(deltaSeconds / (30 * 86400)), 'month');
  return rtf.format(Math.round(deltaSeconds / (365 * 86400)), 'year');
}

export function formatAbsoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(parsed),
  );
}

/**
 * The ETA line.
 *
 * `confidence: "NONE"` means `remaining_ms` is `null` and the server has
 * declined to guess — the UI must not substitute an estimate of its own
 * (`api-usage-guide.md` §7 rule 2, Phase 9 rule 175). The word "Estimated" is
 * always present and completion is never promised (rules 38, 174).
 */
export function formatEstimate(estimate: {
  remaining_ms: number | null;
  /**
   * `NONE` or `LOW` today. Typed as `string` because §7.6 allows a closed
   * vocabulary to gain values within `v1`, and an unrecognized one must be
   * treated as unknown rather than crash — which here means falling through to
   * the same branch as a measured estimate, since anything that is not `NONE`
   * carries a `remaining_ms`.
   */
  confidence: string;
}): string | null {
  if (estimate.confidence === 'NONE' || estimate.remaining_ms === null) return null;
  const duration = formatDuration(estimate.remaining_ms);
  return duration ? `Estimated ${duration} remaining` : null;
}

/** `en-GB` → `English (United Kingdom)`, falling back to the tag itself. */
export function formatLanguage(tag: string | null | undefined): string {
  if (!tag) return '—';
  try {
    const display = new Intl.DisplayNames(undefined, { type: 'language' }).of(tag);
    return display && display !== tag ? display : tag;
  } catch {
    return tag;
  }
}

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
