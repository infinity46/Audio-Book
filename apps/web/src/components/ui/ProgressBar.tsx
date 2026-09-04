import { cn } from '@/lib/cn';
import { formatCount, formatProgress } from '@/lib/format';
import type { Tone } from '@/lib/status';

/**
 * The progress primitive (Phase 9 rules 17, 40).
 *
 * Every number it renders comes from the server. There are no timers, no
 * increments, and no "almost done" state — and, critically, a `null`
 * denominator renders as an indeterminate *"Preparing…"* bar rather than as
 * `0%`, because `api-usage-guide.md` §7 is explicit that `null ≠ 0`: it means
 * the server cannot yet know the total, not that nothing is done.
 */

const FILL_TONE: Record<Tone, string> = {
  neutral: 'bg-[var(--tone-neutral)]',
  progress: 'bg-[var(--tone-progress)]',
  success: 'bg-[var(--tone-success)]',
  warning: 'bg-[var(--tone-warning)]',
  danger: 'bg-[var(--tone-danger)]',
};

export interface ProgressBarProps {
  /** `0.0`–`1.0` from the API, or `null` when the denominator is unknown. */
  value: number | null | undefined;
  label: string;
  tone?: Tone;
  completedUnits?: number;
  totalUnits?: number | null;
  unitNoun?: { one: string; many: string };
  size?: 'sm' | 'md';
  className?: string;
  /** Hide the label row when the caller renders its own heading. */
  hideLabel?: boolean;
}

export function ProgressBar({
  value,
  label,
  tone = 'progress',
  completedUnits,
  totalUnits,
  unitNoun,
  size = 'md',
  className,
  hideLabel = false,
}: ProgressBarProps) {
  const measurable = value !== null && value !== undefined;
  const percentText = formatProgress(value);
  const pct = measurable ? Math.max(0, Math.min(100, value * 100)) : 0;

  const counts =
    completedUnits !== undefined && unitNoun
      ? totalUnits !== null && totalUnits !== undefined
        ? `${formatCount(completedUnits)} of ${formatCount(totalUnits)} ${unitNoun.many}`
        : // Honest: we know how many are done, not how many there will be.
          `${formatCount(completedUnits)} ${unitNoun.many} so far`
      : null;

  return (
    <div className={cn('w-full', className)}>
      {hideLabel ? null : (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] font-medium text-[var(--text-secondary)]">
            {label}
          </span>
          <span className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
            {percentText ?? 'Preparing…'}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label}
        // An indeterminate bar omits `aria-valuenow` entirely — that, not a
        // fabricated 0, is how a screen reader is told "unknown".
        aria-valuenow={measurable ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={measurable ? `${percentText}` : 'Preparing, total not yet known'}
        className={cn(
          'w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--panel-sunken)]',
          size === 'sm' ? 'h-1.5' : 'h-2.5',
        )}
      >
        {measurable ? (
          <div
            className={cn('h-full rounded-[var(--radius-pill)] transition-[width] duration-500 ease-out', FILL_TONE[tone])}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className={cn('h-full w-1/3 rounded-[var(--radius-pill)] opacity-60', FILL_TONE[tone], 'animate-[indeterminate_1.6s_ease-in-out_infinite]')} />
        )}
      </div>
      {counts ? (
        <p className="mt-1.5 text-[12px] tabular-nums text-[var(--text-muted)]">{counts}</p>
      ) : null}
      <style>{`@keyframes indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}
