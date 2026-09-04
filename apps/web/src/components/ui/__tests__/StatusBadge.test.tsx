import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../StatusBadge';

describe('StatusBadge', () => {
  it('carries the status as text, not only as colour', () => {
    // Rule 103. The label is the accessible channel; the glyph is the
    // non-colour visual one.
    const { container } = render(<StatusBadge label="Review required" tone="warning" />);
    expect(screen.getByText('Review required')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('uses a different glyph shape per tone, so greyscale still distinguishes them', () => {
    const success = render(<StatusBadge label="Ready" tone="success" />).container.innerHTML;
    const danger = render(<StatusBadge label="Failed" tone="danger" />).container.innerHTML;
    const warning = render(<StatusBadge label="Review" tone="warning" />).container.innerHTML;
    expect(success).not.toBe(danger);
    expect(danger).not.toBe(warning);
  });

  it('hides the decorative glyph from assistive technology', () => {
    const { container } = render(<StatusBadge label="Ready" tone="success" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('exposes the longer explanation as a tooltip', () => {
    render(
      <StatusBadge
        label="Cancelling"
        tone="warning"
        description="The worker stops at its next safe point."
      />,
    );
    expect(screen.getByTitle('The worker stops at its next safe point.')).toBeInTheDocument();
  });
});
