'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';

/**
 * Drag-and-drop source picker (Phase 9 rules 13, 14, 84).
 *
 * Drag/drop is the convenient path; the `<input type="file">` underneath is the
 * *accessible* one, and it is a real focusable control rather than a visually
 * hidden afterthought — the whole zone is a `<label>` for it, so Space/Enter on
 * the keyboard opens the picker exactly as a click does.
 */
export function FileDropZone({
  onFileSelected,
  accept,
  maxBytes,
  file,
  disabled = false,
  error,
}: {
  onFileSelected: (file: File | null) => void;
  accept: string;
  maxBytes: number | null;
  file: File | null;
  disabled?: boolean;
  error?: string | null;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;
      const dropped = event.dataTransfer.files?.[0];
      if (dropped) onFileSelected(dropped);
    },
    [disabled, onFileSelected],
  );

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={handleDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-panel)]',
          'border-2 border-dashed px-6 py-10 text-center transition-colors',
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]',
          dragging
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--border-default)] bg-[var(--panel-sunken)] hover:border-[var(--border-strong)]',
          disabled && 'cursor-not-allowed opacity-60',
          error && 'border-[var(--tone-danger)]',
        )}
      >
        <svg viewBox="0 0 24 24" className="mb-3 h-8 w-8 text-[var(--text-muted)]" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15V4M8.5 7.5 12 4l3.5 3.5" />
            <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
          </g>
        </svg>
        {file ? (
          <>
            <span className="text-sm font-semibold break-all text-[var(--text-primary)]">
              {file.name}
            </span>
            <span className="mt-1 text-[13px] text-[var(--text-muted)]">
              {formatBytes(file.size)} · choose a different file to replace it
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              Drop a PDF or EPUB here
            </span>
            <span className="mt-1 text-[13px] text-[var(--text-muted)]">
              or select a file
              {maxBytes ? ` · up to ${formatBytes(maxBytes)}` : ''}
            </span>
          </>
        )}
        <input
          id={inputId}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error) || undefined}
          className="sr-only"
          onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)}
        />
      </label>
      {error ? (
        <p id={errorId} className="mt-2 text-[12px] font-medium text-[var(--tone-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
