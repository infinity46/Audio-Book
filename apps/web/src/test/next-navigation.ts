import { vi } from 'vitest';

/**
 * Stubs the App Router hooks a component under test may reach for.
 *
 * Import for its side effect at the top of a test file that renders a component
 * using `useRouter`/`usePathname`.
 */
export const pushMock = vi.fn();
export const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
