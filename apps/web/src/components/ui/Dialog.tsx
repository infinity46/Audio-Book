'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import { cn } from '@/lib/cn';

/**
 * Modal dialog, built on the native `<dialog>` element.
 *
 * Chosen deliberately over a hand-rolled overlay: `showModal()` gives correct
 * focus containment, `Escape` handling, background inertness, and — the part
 * hand-rolled traps usually get wrong — **focus restoration to the element that
 * opened it**, from the browser rather than from application code. That is
 * exactly the property rule 129 asks for, and the one that most often breaks.
 *
 * Rule 106: dialogs here are for confirmations and short forms only. Complex
 * workflows (upload, casting, generation config, review) are pages.
 */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Rendered right-aligned in the footer. Falls back to a single Close. */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Blocks dismissal while a submission is in flight. */
  busy?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'sm',
  busy = false,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  // `close` fires for Escape and for `close()`, so this is the single place the
  // parent's state is reconciled with the element's.
  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      if (busy) event.preventDefault();
    },
    [busy],
  );

  // Clicking the backdrop closes; clicking the panel does not. The check is on
  // the event target being the dialog itself, which is the backdrop region.
  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (busy) return;
      if (event.target === ref.current) onOpenChange(false);
    },
    [busy, onOpenChange],
  );

  return (
    <dialog
      ref={ref}
      onClose={handleClose}
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        'w-[calc(100vw-2rem)] rounded-[var(--radius-panel)] border border-[var(--border-default)]',
        'bg-[var(--panel)] p-0 text-[var(--text-primary)] shadow-[var(--shadow-overlay)]',
        'backdrop:bg-[var(--overlay-scrim)] backdrop:backdrop-blur-[2px]',
        'open:animate-[dialog-in_140ms_ease-out]',
        size === 'lg' ? 'max-w-2xl' : size === 'md' ? 'max-w-lg' : 'max-w-md',
      )}
    >
      <div className="px-5 pt-5 pb-4">
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? (
          <div id={descriptionId} className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {description}
          </div>
        ) : null}
        {children ? <div className="mt-4">{children}</div> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--panel-sunken)] px-5 py-3">
        {footer ?? (
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
        )}
      </div>
      <style>{`@keyframes dialog-in{from{opacity:0;transform:translateY(6px) scale(0.99)}to{opacity:1;transform:none}}`}</style>
    </dialog>
  );
}

/**
 * Confirmation for a destructive or expensive action (rules 38, 50, 111).
 *
 * The `consequence` slot is mandatory by construction: every call site has to
 * state what actually happens, so a confirmation can never be a bare
 * "Are you sure?".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  busy = false,
  destructive = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  consequence: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={consequence}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
