'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Shows a spinner and blocks re-submission. Rule 39: a request in flight must
   * not be submittable twice from the UI, even though the API's
   * `Idempotency-Key` is what actually guarantees it server-side.
   */
  loading?: boolean;
  /**
   * Why the button is disabled. Rule 160 forbids a dead control: a disabled
   * button must say why, and this becomes both the tooltip and the
   * screen-reader description.
   */
  disabledReason?: string;
  iconLeading?: React.ReactNode;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--text-inverse)] border-transparent hover:bg-[var(--accent-hover)]',
  secondary:
    'bg-[var(--panel)] text-[var(--text-primary)] border-[var(--border-default)] hover:bg-[var(--panel-raised)]',
  ghost:
    'bg-transparent text-[var(--text-secondary)] border-transparent hover:bg-[var(--panel-raised)] hover:text-[var(--text-primary)]',
  danger:
    'bg-[var(--tone-danger)] text-[var(--text-inverse)] border-transparent hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabledReason,
    iconLeading,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={isDisabled}
      // `title` is the pointer affordance; `aria-description` carries the same
      // sentence to assistive tech, which does not read `title` reliably.
      title={isDisabled && disabledReason ? disabledReason : rest.title}
      aria-description={isDisabled && disabledReason ? disabledReason : undefined}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-control)] border font-medium',
        'transition-colors duration-150 select-none',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner /> : iconLeading}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 animate-spin"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
