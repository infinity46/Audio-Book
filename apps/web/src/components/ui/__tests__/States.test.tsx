import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { EmptyState, ErrorState } from '../States';

describe('ErrorState', () => {
  it('announces itself as an alert', () => {
    render(<ErrorState error={new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: '' })} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers Try again only when retrying could actually work', async () => {
    const onRetry = vi.fn();
    // 403 is not retryable; offering the control would be a lie.
    const { rerender } = render(
      <ErrorState error={new ApiError({ status: 403, code: 'FORBIDDEN', message: '' })} onRetry={onRetry} />,
    );
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();

    rerender(<ErrorState error={new NetworkError('offline')} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the request id for a support report and never a stack trace', () => {
    const error = new ApiError({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'boom',
      requestId: 'req-42',
    });
    error.stack = 'Error: boom\n  at somewhere/secret/path.ts:12';
    render(<ErrorState error={error} />);
    expect(screen.getByText(/req-42/)).toBeInTheDocument();
    expect(screen.queryByText(/secret\/path/)).not.toBeInTheDocument();
  });

  it('translates a pipeline conflict into an actionable sentence', () => {
    render(
      <ErrorState
        error={new ApiError({ status: 409, code: 'CASTING_INCOMPLETE', message: 'raw' })}
      />,
    );
    expect(screen.getByText(/Some characters have no voice/i)).toBeInTheDocument();
    expect(screen.getByText(/Assign a voice to every speaking character/i)).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('names the state and offers the way out of it', () => {
    render(
      <EmptyState
        title="No audiobooks yet"
        description="Create a project to begin."
        action={<button type="button">Create audiobook</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No audiobooks yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create audiobook' })).toBeInTheDocument();
  });
});
