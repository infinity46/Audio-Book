'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Toasts (Phase 9 rule 112).
 *
 * For **lightweight, successful** actions only — "Voice assigned", "Metadata
 * saved". A toast is never the only place a critical error or a long-running
 * status appears: errors render inline where the action was taken
 * (`ErrorState`), and generation status lives persistently in the project
 * workspace (rule 113). This provider deliberately offers no `error` variant
 * for that reason; the strongest tone it has is `warning`, for an outcome the
 * user should notice but that does not need a place to return to.
 */

export interface Toast {
  id: string;
  message: string;
  tone: 'success' | 'warning' | 'info';
  /** Optional undo/goto affordance. */
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  toast: (input: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_TTL_MS = 6000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      setToasts((current) => [...current.slice(-3), { ...input, id }]);
      setTimeout(() => dismiss(id), TOAST_TTL_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        `role="status"` + `aria-live="polite"` announces without stealing focus.
        The region exists even when empty so announcements are picked up.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[var(--radius-control)]',
              'border bg-[var(--panel)] px-4 py-3 shadow-[var(--shadow-raised)]',
              item.tone === 'success' && 'border-[var(--tone-success)]/35',
              item.tone === 'warning' && 'border-[var(--tone-warning)]/40',
              item.tone === 'info' && 'border-[var(--border-default)]',
            )}
          >
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--text-primary)]">
              {item.message}
            </span>
            {item.action ? (
              <button
                type="button"
                onClick={() => {
                  item.action?.onClick();
                  dismiss(item.id);
                }}
                className="shrink-0 text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
              >
                {item.action.label}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>.');
  }
  return context;
}
