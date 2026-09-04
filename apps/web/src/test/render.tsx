import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectContextProvider } from '@/components/project/ProjectContext';
import type { BookProgress, BookWithStages } from '@/lib/api/types';
import { makeBookWithStages, makeProgress, BOOK_ID } from './msw/fixtures';

/**
 * Renders a component with the same providers the app uses.
 *
 * Query retries are off and `gcTime` is zero so a test's cache never leaks into
 * the next one — but the client, the error normalization, and the invalidation
 * behaviour are the real ones.
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderOptions & { queryClient?: QueryClient } = {},
) {
  const { queryClient = makeTestQueryClient(), ...rest } = options;
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>,
      rest,
    ),
  };
}

/** Renders inside a project workspace context, for tab components. */
export function renderInProject(
  ui: React.ReactElement,
  overrides: {
    book?: BookWithStages | null;
    progress?: BookProgress | null;
    streaming?: boolean;
  } = {},
) {
  return renderWithProviders(
    <ProjectContextProvider
      value={{
        bookId: BOOK_ID,
        book: overrides.book === undefined ? makeBookWithStages() : overrides.book,
        etag: '"9f2c"',
        progress: overrides.progress === undefined ? makeProgress() : overrides.progress,
        streaming: overrides.streaming ?? false,
        refetch: () => {},
      }}
    >
      {ui}
    </ProjectContextProvider>,
  );
}
