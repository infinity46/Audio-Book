import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, Dialog } from '../Dialog';

describe('Dialog', () => {
  it('is labelled and described by its own heading and text', () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Cancel this work?" description="Finished work is kept.">
        <p>body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { hidden: true });
    const heading = screen.getByRole('heading', { name: 'Cancel this work?' });
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
    expect(dialog).toHaveAttribute('aria-describedby');
  });

  it('reports closing back to the parent when dismissed', async () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="Title" />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('refuses to be dismissed by Escape while a submission is in flight', () => {
    // Losing the dialog mid-request would leave the user unsure whether the
    // expensive command was actually sent.
    const onOpenChange = vi.fn();
    render(<Dialog open busy onOpenChange={onOpenChange} title="Generating" />);
    const dialog = screen.getByRole('dialog', { hidden: true });
    const cancelEvent = new Event('cancel', { cancelable: true, bubbles: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
  });
});

describe('ConfirmDialog', () => {
  it('always states the consequence, never just "are you sure?"', () => {
    // The `consequence` slot is required by the component's own signature, so
    // a bare confirmation cannot be written.
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Change this character’s voice?"
        consequence="Existing audio is not altered."
        confirmLabel="Change voice"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('Existing audio is not altered.')).toBeInTheDocument();
  });

  it('runs the action only on the confirm control', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Cancel work?"
        consequence="Finished work is kept."
        confirmLabel="Request cancellation"
        onConfirm={onConfirm}
        destructive
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await userEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
