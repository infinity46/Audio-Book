import '@/test/next-navigation';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { renderWithProviders } from '@/test/render';
import { makeBook, makeProgress } from '@/test/msw/fixtures';
import { ProjectCard } from '../ProjectCard';

const BASE = '/bff/api/v1';

describe('ProjectCard', () => {
  it('shows the project’s state and the next thing to do with it', () => {
    render(<ProjectCard book={makeBook({ status: 'SCRIPTED' })} />);
    expect(screen.getByText('Script ready')).toBeInTheDocument();
    expect(screen.getByText(/Configure and generate/)).toBeInTheDocument();
  });

  it('renders no progress bar when the caller supplied no measurement', () => {
    // `GET /books` cannot embed stage progress, so a card without an explicit
    // progress reading must not invent one.
    render(<ProjectCard book={makeBook()} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders a progress bar when a real reading is supplied', () => {
    render(<ProjectCard book={makeBook()} progress={makeProgress()} />);
    expect(screen.getByRole('progressbar', { name: /overall progress/i })).toHaveAttribute(
      'aria-valuenow',
      '58',
    );
  });

  it('flags a project awaiting review even when its status is something else', () => {
    render(<ProjectCard book={makeBook({ status: 'GENERATING', needs_review: true })} />);
    expect(screen.getByText('Review required')).toBeInTheDocument();
  });

  it('wraps a long title rather than silently truncating it away', () => {
    // Rule 104: important information is never truncated without recourse.
    const title = 'A Very Long Book Title That Would Otherwise Be Cut Off Somewhere In The Middle';
    render(<ProjectCard book={makeBook({ title })} />);
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it('links the whole card to the project workspace', () => {
    const book = makeBook();
    render(<ProjectCard book={book} />);
    expect(screen.getByRole('link', { name: book.title })).toHaveAttribute(
      'href',
      `/projects/${book.id}`,
    );
  });
});

describe('ProjectCard — deleted book actions (Phase 10 restore/purge)', () => {
  it('a deleted book is not a link, and offers restore/delete-permanently instead', () => {
    const book = makeBook({ deleted_at: '2026-08-28T00:00:00.000Z' });
    renderWithProviders(<ProjectCard book={book} />);

    expect(screen.queryByRole('link', { name: book.title })).not.toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeInTheDocument();
  });

  it('restores a deleted book with one click, no confirmation needed', async () => {
    let called = false;
    server.use(
      http.post(`${BASE}/books/:bookId/restoration`, () => {
        called = true;
        return HttpResponse.json({ data: makeBook({ deleted_at: null }) });
      }),
    );
    const book = makeBook({ deleted_at: '2026-08-28T00:00:00.000Z' });
    renderWithProviders(<ProjectCard book={book} />);

    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(called).toBe(true));
  });

  it('gates permanent deletion on typing the exact project title', async () => {
    const book = makeBook({ deleted_at: '2026-08-28T00:00:00.000Z', title: 'The Long Voyage' });
    renderWithProviders(<ProjectCard book={book} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    const confirmButton = screen.getAllByRole('button', { name: 'Delete permanently' })[1]!;
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Project title'), 'wrong title');
    expect(confirmButton).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Project title'));
    await userEvent.type(screen.getByLabelText('Project title'), 'The Long Voyage');
    expect(confirmButton).toBeEnabled();
  });

  it('purges with confirm_book_id equal to the book id once confirmed', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/books/:bookId/purge`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { job: { id: 'job-1' } } }, { status: 202 });
      }),
    );
    const book = makeBook({ deleted_at: '2026-08-28T00:00:00.000Z', title: 'The Long Voyage' });
    renderWithProviders(<ProjectCard book={book} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await userEvent.type(screen.getByLabelText('Project title'), 'The Long Voyage');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete permanently' })[1]!);

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ confirm_book_id: book.id });
  });
});
