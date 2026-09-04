'use client';

import { createContext, useContext } from 'react';
import type { BookWithStages, BookProgress } from '@/lib/api/types';

/**
 * Workspace context.
 *
 * Carries only what every tab needs and what would otherwise be re-derived
 * inconsistently: the book id, the live-stream flag that tunes each tab's
 * polling, and the already-fetched book/progress reads. It is **not** a client
 * store — the values come from the query cache and the server remains
 * authoritative (rule 95).
 */
export interface ProjectContextValue {
  bookId: string;
  book: BookWithStages | null;
  etag: string | null;
  progress: BookProgress | null;
  streaming: boolean;
  refetch: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectContextProvider = ProjectContext.Provider;

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProject must be used inside the project workspace.');
  return value;
}
