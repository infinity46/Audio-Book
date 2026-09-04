import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from '../ProgressBar';

/**
 * The progress primitive carries the `null ≠ 0` rule into the DOM, including
 * into the accessibility tree — an indeterminate bar must not announce "0%".
 */
describe('ProgressBar', () => {
  it('renders an indeterminate bar when the denominator is unknown', () => {
    render(<ProgressBar value={null} label="Generating audio" />);
    const bar = screen.getByRole('progressbar', { name: 'Generating audio' });
    // No aria-valuenow at all: that is how "unknown" is expressed, not as 0.
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', 'Preparing, total not yet known');
    expect(screen.getByText('Preparing…')).toBeInTheDocument();
  });

  it('announces a measured value as a percentage', () => {
    render(<ProgressBar value={0.61} label="Generating audio" />);
    const bar = screen.getByRole('progressbar', { name: 'Generating audio' });
    expect(bar).toHaveAttribute('aria-valuenow', '61');
    expect(bar).toHaveAttribute('aria-valuetext', '61%');
  });

  it('says how many units are done but not how many there will be, when the total is unknown', () => {
    render(
      <ProgressBar
        value={null}
        label="Generating audio"
        completedUnits={1200}
        totalUnits={null}
        unitNoun={{ one: 'segment', many: 'segments' }}
      />,
    );
    expect(screen.getByText('1,200 segments so far')).toBeInTheDocument();
    expect(screen.queryByText(/of 0/)).not.toBeInTheDocument();
  });

  it('shows the full fraction once the total is known', () => {
    render(
      <ProgressBar
        value={0.61}
        label="Generating audio"
        completedUnits={5180}
        totalUnits={8420}
        unitNoun={{ one: 'segment', many: 'segments' }}
      />,
    );
    expect(screen.getByText('5,180 of 8,420 segments')).toBeInTheDocument();
  });

  it('does not display 100% while the value is merely close', () => {
    render(<ProgressBar value={0.998} label="Generating audio" />);
    expect(screen.getByText('99%')).toBeInTheDocument();
  });
});
