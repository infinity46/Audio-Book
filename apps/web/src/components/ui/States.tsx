'use client';

import { Button } from './Button';
import { Panel } from './Panel';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/api/errors';

/**
 * Empty and error states (Phase 9 rules 79, 81, 82).
 *
 * Every asynchronous surface in the studio uses these, so "loading / empty /
 * error" is never something an individual page has to remember to design.
 */

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon ? <div className="mb-4 text-[var(--text-muted)]">{icon}</div> : null}
      <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * The error surface. Shows what happened, whether retrying is honest, and the
 * `request_id` to quote — never a stack trace, never a raw code as the headline
 * (`error-handling.md` §1).
 */
export function ErrorState({
  error,
  onRetry,
  secondaryAction,
  className,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  secondaryAction?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const presentation = describeError(error);

  return (
    <div
      role="alert"
      className={cn(
        'rounded-[var(--radius-panel)] border border-[var(--tone-danger)]/30 bg-[var(--tone-danger-soft)]',
        compact ? 'px-4 py-3' : 'px-5 py-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tone-danger)]" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 4.6v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.2" r="0.9" fill="currentColor" />
        </svg>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{presentation.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {presentation.message}
          </p>
          {presentation.requestId ? (
            <p className="mt-2 font-mono text-[11px] break-all text-[var(--text-muted)]">
              Request {presentation.requestId}
            </p>
          ) : null}
          {(onRetry && presentation.canRetry) || secondaryAction ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry && presentation.canRetry ? (
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
              {secondaryAction}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Full-panel variant, for when an entire page could not load. */
export function ErrorPanel(props: React.ComponentProps<typeof ErrorState>) {
  return (
    <Panel className="overflow-hidden border-[var(--tone-danger)]/25">
      <ErrorState {...props} className="border-0 bg-transparent" />
    </Panel>
  );
}

/**
 * An inline notice that is not an error — an advisory, a degraded read, a
 * consequence the user should know about before acting (rules 33, 38, 50, 183).
 */
export function Notice({
  tone = 'warning',
  title,
  children,
  className,
  action,
}: {
  tone?: 'warning' | 'info' | 'danger';
  title: string;
  children?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-[var(--tone-danger)]/30 bg-[var(--tone-danger-soft)]'
      : tone === 'info'
        ? 'border-[var(--tone-progress)]/30 bg-[var(--tone-progress-soft)]'
        : 'border-[var(--tone-warning)]/35 bg-[var(--tone-warning-soft)]';

  return (
    <div className={cn('rounded-[var(--radius-control)] border px-4 py-3', toneClass, className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</p>
          {children ? (
            <div className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {children}
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}
