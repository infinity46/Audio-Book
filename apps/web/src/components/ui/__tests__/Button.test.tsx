import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../Button';

describe('Button', () => {
  it('blocks a second submission while a request is in flight', async () => {
    // Rule 39. The API's Idempotency-Key is the real guarantee; this stops the
    // user generating a second intent in the first place.
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Generate
      </Button>,
    );
    const button = screen.getByRole('button', { name: /generate/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button, { pointerEventsCheck: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('explains why it is disabled, to both pointer and assistive users', () => {
    // Rule 160: a disabled control must say why, not just be inert.
    render(
      <Button disabled disabledReason="Assign a voice to every speaking character first.">
        Generate audio
      </Button>,
    );
    const button = screen.getByRole('button', { name: /generate audio/i });
    expect(button).toHaveAttribute('title', 'Assign a voice to every speaking character first.');
    expect(button).toHaveAttribute(
      'aria-description',
      'Assign a voice to every speaking character first.',
    );
  });

  it('does not claim a reason when it is enabled', () => {
    render(
      <Button disabledReason="not applicable">
        Go
      </Button>,
    );
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-description');
  });

  it('is keyboard operable', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('defaults to type="button" so it cannot submit a form by accident', () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
