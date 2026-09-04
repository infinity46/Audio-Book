import '@/test/next-navigation';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderInProject } from '@/test/render';
import { makeProgress } from '@/test/msw/fixtures';
import { ProjectOverview } from '../ProjectOverview';

describe('ProjectOverview', () => {
  it('answers "how far has it got" from the server’s own stage projection', async () => {
    renderInProject(<ProjectOverview />);

    expect(await screen.findByText('Production progress')).toBeInTheDocument();
    // The ETA is shown because the fixture has a measured LOW-confidence one.
    expect(screen.getByText(/Estimated .* remaining/)).toBeInTheDocument();
    expect(screen.getByText('58%')).toBeInTheDocument();
  });

  it('renders a running stage with an unknown total as preparing, not as 0%', async () => {
    // The real case: TTS has started, but no script exists yet, so nobody knows
    // how many chunks there will be. `total_units` is null and `progress` is
    // null — which must render as an indeterminate bar, never as 0%.
    const base = makeProgress();
    renderInProject(<ProjectOverview />, {
      progress: makeProgress({
        overall_progress: null,
        stages: base.stages.map((stage) =>
          stage.stage === 'tts'
            ? { ...stage, status: 'RUNNING', progress: null, completed_units: 0, total_units: null }
            : stage,
        ),
      }),
    });

    const bars = await screen.findAllByRole('progressbar');
    const indeterminate = bars.filter((bar) => !bar.hasAttribute('aria-valuenow'));
    expect(indeterminate.length).toBeGreaterThan(0);
    expect(screen.getAllByText('Preparing…').length).toBeGreaterThan(0);
  });

  it('shows no estimate at all when the server declined to make one', async () => {
    renderInProject(<ProjectOverview />, {
      progress: makeProgress({
        estimate: { remaining_ms: null, confidence: 'NONE', basis: null, computed_at: null },
      }),
    });

    expect(await screen.findByText('Production progress')).toBeInTheDocument();
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
  });

  it('reports a degraded read honestly instead of hiding it', async () => {
    renderInProject(<ProjectOverview />, {
      progress: makeProgress({
        degraded: true,
        degraded_reasons: ['WORKER_CAPABILITY_REGISTRY_UNAVAILABLE'],
      }),
    });

    expect(await screen.findByText(/Some figures are unavailable/i)).toBeInTheDocument();
  });

  it('warns that casting is incomplete and links to where it is fixed', async () => {
    renderInProject(<ProjectOverview />);

    expect(await screen.findByText(/Casting is not complete/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open casting/i })).toBeInTheDocument();
  });

  it('surfaces failed and flagged unit counts per stage', async () => {
    renderInProject(<ProjectOverview />);
    expect(await screen.findByText('14 failed')).toBeInTheDocument();
    expect(screen.getByText('6 flagged for review')).toBeInTheDocument();
  });
});
