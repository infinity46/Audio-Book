import { cn } from '@/lib/cn';
import type { Tone } from '@/lib/status';

/**
 * Status indicator (Phase 9 rules 101, 103).
 *
 * Status is carried by **three** independent channels — a text label, a glyph
 * whose shape differs per tone, and colour — so it survives greyscale,
 * colour-blindness, and a screen reader. Colour alone is never the signal.
 */

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-[var(--tone-neutral)] bg-[var(--tone-neutral-soft)] border-[var(--tone-neutral)]/25',
  progress:
    'text-[var(--tone-progress)] bg-[var(--tone-progress-soft)] border-[var(--tone-progress)]/25',
  success: 'text-[var(--tone-success)] bg-[var(--tone-success-soft)] border-[var(--tone-success)]/25',
  warning: 'text-[var(--tone-warning)] bg-[var(--tone-warning-soft)] border-[var(--tone-warning)]/25',
  danger: 'text-[var(--tone-danger)] bg-[var(--tone-danger-soft)] border-[var(--tone-danger)]/25',
};

/** A distinct silhouette per tone — the non-colour channel. */
function ToneGlyph({ tone, spinning }: { tone: Tone; spinning?: boolean }) {
  const common = { className: cn('h-3 w-3 shrink-0', spinning && 'animate-spin'), 'aria-hidden': true as const, focusable: 'false' as const };
  switch (tone) {
    case 'success':
      return (
        <svg viewBox="0 0 12 12" {...common}>
          <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'progress':
      return (
        <svg viewBox="0 0 12 12" {...common}>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" />
          <path d="M6 1.4A4.6 4.6 0 0 1 10.6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 12 12" {...common}>
          <path d="M6 1.2 11.2 10.4H0.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M6 4.6v2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="6" cy="8.6" r="0.75" fill="currentColor" />
        </svg>
      );
    case 'danger':
      return (
        <svg viewBox="0 0 12 12" {...common}>
          <circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.2 4.2l3.6 3.6M7.8 4.2 4.2 7.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 12 12" {...common}>
          <rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

export interface StatusBadgeProps {
  label: string;
  tone: Tone;
  /** Spins the glyph while work is genuinely in flight. */
  active?: boolean;
  /** Sentence shown on hover and exposed to assistive tech. */
  description?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusBadge({
  label,
  tone,
  active = false,
  description,
  size = 'md',
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        TONE_CLASS[tone],
        className,
      )}
      title={description}
    >
      <ToneGlyph tone={tone} spinning={active && tone === 'progress'} />
      {label}
    </span>
  );
}

/** A bare dot + label, for dense table cells where a pill is too heavy. */
export function StatusDot({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', className)}>
      <ToneGlyph tone={tone} />
      <span>{label}</span>
    </span>
  );
}
