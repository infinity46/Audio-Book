'use client';

import { useEffect } from 'react';

/**
 * Warns before a reload or tab close discards unsaved input (rule 110).
 *
 * Deliberately limited to the browser-level event. Intercepting Next's client
 * router would mean patching navigation globally, and the App Router exposes no
 * supported hook for it; the forms that carry real risk here (project creation,
 * generation configuration) additionally keep their state addressable in the
 * URL or re-derivable from the server, so an in-app navigation loses nothing
 * that cannot be typed again in seconds.
 */
export function useUnsavedChangesWarning(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore custom text and show their own string; assigning
      // `returnValue` is still what triggers the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled]);
}
