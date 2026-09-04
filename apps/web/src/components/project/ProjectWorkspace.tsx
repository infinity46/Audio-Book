'use client';

import Link from 'next/link';
import { useBook, useBookProgress } from '@/lib/query/hooks';
import { useBookEventStream } from '@/lib/query/useEventStream';
import { ProjectContextProvider } from './ProjectContext';
import { ProjectNav, type ProjectNavItem } from './ProjectNav';
import { CoverArt } from './CoverArt';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorPanel } from '@/components/ui/States';
import { Panel } from '@/components/ui/Panel';
import { bookStatusDisplay, nextActionForBook } from '@/lib/status';
import { formatRelativeTime } from '@/lib/format';

/**
 * The project workspace shell (Phase 9 rules 18, 45, 108, 113, 168).
 *
 * Everything here is reconstructed from the API on every mount, so a browser
 * reload mid-generation lands on exactly the same state (rule 45) and two tabs
 * on the same project agree because neither holds authoritative state (rule 46).
 *
 * The header is the persistent status surface rule 113 asks for: it says what
 * the project's state is and what the next step is on **every** tab, so a
 * long-running generation is never something the user has to have kept a toast
 * around to know about.
 */
export function ProjectWorkspace({
  bookId,
  children,
}: {
  bookId: string;
  children: React.ReactNode;
}) {
  const stream = useBookEventStream(bookId);
  const bookQuery = useBook(bookId);
  const progressQuery = useBookProgress(bookId, { streaming: stream.streaming });

  const book = bookQuery.data?.data ?? null;
  const progress = progressQuery.data ?? null;

  if (bookQuery.isError) {
    return (
      <ErrorPanel
        error={bookQuery.error}
        onRetry={() => void bookQuery.refetch()}
        secondaryAction={
          <Link href="/projects" className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline">
            Back to projects
          </Link>
        }
      />
    );
  }

  const status = bookStatusDisplay(progress?.book_status ?? book?.status ?? 'CREATED');
  const flaggedCount = progress?.needs_review_count ?? null;
  const failedUnits = progress?.stages.reduce((sum, stage) => sum + stage.failed_units, 0) ?? null;

  const navItems: ProjectNavItem[] = [
    { segment: '', label: 'Overview' },
    { segment: 'book', label: 'Book' },
    { segment: 'characters', label: 'Characters' },
    { segment: 'voices', label: 'Voices' },
    { segment: 'generation', label: 'Generation' },
    { segment: 'review', label: 'Review', badge: flaggedCount, badgeTone: 'warning' },
    { segment: 'chapters', label: 'Chapters' },
    { segment: 'audiobook', label: 'Audiobook' },
    { segment: 'jobs', label: 'Activity', badge: failedUnits, badgeTone: 'danger' },
  ];

  const action = book
    ? nextActionForBook({
        status: progress?.book_status ?? book.status,
        needsReview: progress?.needs_review ?? book.needs_review,
        hasSourceFile: Boolean(book.current_book_version_id),
        audiobookReady: (progress?.book_status ?? book.status) === 'COMPLETED',
      })
    : null;

  return (
    <ProjectContextProvider
      value={{
        bookId,
        book,
        etag: bookQuery.data?.etag ?? null,
        progress,
        streaming: stream.streaming,
        refetch: () => {
          void bookQuery.refetch();
          void progressQuery.refetch();
        },
      }}
    >
      <div className="space-y-6">
        <header>
          <nav aria-label="Breadcrumb" className="mb-3">
            <Link href="/projects" className="text-[13px] text-[var(--text-muted)] hover:underline">
              ← Projects
            </Link>
          </nav>

          <Panel className="p-5">
            <div className="flex flex-wrap items-start gap-4">
              {book ? (
                <CoverArt bookId={book.id} title={book.title} />
              ) : (
                <div className="skeleton h-16 w-11 rounded-[0.35rem]" />
              )}
              <div className="min-w-0 flex-1">
                {book ? (
                  <>
                    <h1 className="text-xl leading-tight font-semibold tracking-tight break-words text-[var(--text-primary)]">
                      {book.title}
                    </h1>
                    <p className="mt-1 text-[13px] text-[var(--text-muted)]">
                      {book.author ?? 'Unknown author'} · Updated{' '}
                      <time dateTime={book.updated_at}>{formatRelativeTime(book.updated_at)}</time>
                    </p>
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="skeleton h-6 w-64" />
                    <div className="skeleton h-3.5 w-40" />
                  </div>
                )}
              </div>

              <div className="flex flex-col items-end gap-2">
                <StatusBadge
                  label={status.label}
                  tone={status.tone}
                  active={status.active}
                  description={status.description}
                />
                {stream.streaming ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--tone-success)]" aria-hidden="true" />
                    Live
                  </span>
                ) : null}
              </div>
            </div>

            {action ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
                <p className="text-[13px] text-[var(--text-secondary)]">{action.rationale}</p>
                <Link
                  href={`/projects/${bookId}${action.route === 'overview' ? '' : `/${action.route}`}`}
                  className="inline-flex h-9 shrink-0 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-[var(--text-inverse)] hover:bg-[var(--accent-hover)]"
                >
                  {action.label}
                </Link>
              </div>
            ) : null}
          </Panel>
        </header>

        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <ProjectNav bookId={bookId} items={navItems} />
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    </ProjectContextProvider>
  );
}
