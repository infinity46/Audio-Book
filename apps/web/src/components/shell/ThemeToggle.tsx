'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

type Theme = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'audiobook-studio-theme';

/**
 * Theme control (rule 158).
 *
 * Purely a viewer preference, so `localStorage` is the right home for it — it
 * is per-browser, needs no server round trip, and losing it costs nothing. All
 * three reads/writes are guarded: a private window or a browser configured to
 * block site data throws on access rather than returning null.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') setTheme(stored);
    } catch {
      /* storage unavailable — the system preference still applies */
    }
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    try {
      if (next === 'system') {
        localStorage.removeItem(STORAGE_KEY);
        document.documentElement.removeAttribute('data-theme');
      } else {
        localStorage.setItem(STORAGE_KEY, next);
        document.documentElement.setAttribute('data-theme', next);
      }
    } catch {
      /* preference cannot be persisted; the in-page change still applies */
    }
  };

  const options: { value: Theme; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <fieldset className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] bg-[var(--panel-sunken)] p-0.5">
      <legend className="sr-only">Colour theme</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'cursor-pointer rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] font-medium transition-colors',
            theme === option.value
              ? 'bg-[var(--panel)] text-[var(--text-primary)] shadow-[var(--shadow-panel)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
          )}
        >
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => apply(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
