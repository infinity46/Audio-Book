import '@/test/next-navigation';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { server } from '@/test/msw/server';
import { apiError, collection } from '@/test/msw/handlers';
import { renderWithProviders } from '@/test/render';
import { DashboardView } from '../DashboardView';

const BASE = '/bff/api/v1';

describe('DashboardView', () => {
  it('shows a useful empty state with a way to start, not a blank page', async () => {
    server.use(
      http.get(`${BASE}/books`, () => collection([])),
      http.get(`${BASE}/jobs`, () => collection([])),
    );

    renderWithProviders(<DashboardView />);

    expect(await screen.findByText('No audiobooks yet')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /create your first audiobook/i }),
    ).toHaveAttribute('href', '/projects/new');
  });

  it('separates work needing attention from work in progress', async () => {
    renderWithProviders(<DashboardView />);

    // The fixture book is GENERATING, so it lands under "In production".
    expect(await screen.findByRole('heading', { name: /in production/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /recent projects/i })).toBeInTheDocument();
  });

  it('surfaces failed jobs with the code the API reported', async () => {
    renderWithProviders(<DashboardView />);
    expect(await screen.findByRole('heading', { name: /needs your attention/i })).toBeInTheDocument();
    expect(await screen.findByText(/TTS_PROVIDER_ERROR/)).toBeInTheDocument();
  });

  it('renders an actionable error instead of crashing when the list read fails', async () => {
    server.use(
      http.get(`${BASE}/books`, () => apiError(503, 'DEPENDENCY_UNAVAILABLE', 'down', { retryable: true })),
      http.get(`${BASE}/jobs`, () => collection([])),
    );

    renderWithProviders(<DashboardView />);

    await waitFor(
      () => {
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    expect(screen.getAllByText(/temporarily unavailable/i).length).toBeGreaterThan(0);
  }, 20_000);

  it('shows a quota that is unknown as unknown, never as zero', async () => {
    server.use(
      // The quota read fails open by contract: 200 with `degraded: true` and
      // `used: null`, so a dashboard still renders during an aggregator outage.
      http.get(`${BASE}/users/me/quotas`, () =>
        HttpResponse.json({
          data: {
            object: 'quota_summary',
            degraded: true,
            quotas: [{ dimension: 'GPU_MINUTES', limit: 600, used: null }],
          },
        }),
      ),
    );

    renderWithProviders(<DashboardView />);

    expect(await screen.findByText(/usage figures are unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
