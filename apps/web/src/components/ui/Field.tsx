'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Form primitives (Phase 9 rules 71, 83).
 *
 * Every control is bound to a real `<label>`, and validation messages are
 * associated through `aria-describedby` + `aria-invalid` so they are announced
 * rather than merely coloured. Field errors come from the API's own
 * `details[].field`/`issue` pairs wherever the server produced them — the
 * client does not maintain a competing rule set (rule 71).
 */

interface FieldShellProps {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (props: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
}

export function Field({ label, hint, error, required, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--text-secondary)]">
        {label}
        {required ? (
          <span className="ml-1 text-[var(--tone-danger)]" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[12px] font-medium text-[var(--tone-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-[var(--radius-control)] border bg-[var(--panel)] px-3 py-2 text-sm ' +
  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] ' +
  'border-[var(--border-default)] transition-colors ' +
  'aria-[invalid=true]:border-[var(--tone-danger)] disabled:opacity-60';

export function TextInput({
  className,
  invalid,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cn(CONTROL_CLASS, className)} />;
}

export function TextArea({
  className,
  invalid,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(CONTROL_CLASS, 'min-h-24 resize-y', className)}
    />
  );
}

export function Select({
  className,
  invalid,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} aria-invalid={invalid || undefined} className={cn(CONTROL_CLASS, 'pr-8', className)}>
      {children}
    </select>
  );
}

/** A labelled group of radio-style choices, used for scope and format pickers. */
export function ChoiceGroup({
  legend,
  hint,
  children,
  className,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('space-y-2', className)}>
      <legend className="text-[13px] font-medium text-[var(--text-secondary)]">{legend}</legend>
      {hint ? <p className="text-[12px] text-[var(--text-muted)]">{hint}</p> : null}
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

export function ChoiceOption({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  disabled,
  disabledReason,
  type = 'radio',
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string, checked: boolean) => void;
  title: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  type?: 'radio' | 'checkbox';
}) {
  const id = useId();
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-control)] border px-3 py-2.5 transition-colors',
        checked
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[var(--border-subtle)] bg-[var(--panel)]',
        disabled && 'opacity-60',
      )}
      title={disabled ? disabledReason : undefined}
    >
      <input
        id={id}
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(value, event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--text-muted)]">
            {description}
          </span>
        ) : null}
        {disabled && disabledReason ? (
          <span className="mt-0.5 block text-[12px] text-[var(--tone-warning)]">{disabledReason}</span>
        ) : null}
      </label>
    </div>
  );
}
