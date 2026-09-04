'use client';

import Link from 'next/link';
import { useBookList, useJobs, useQuotas } from '@/lib/query/hooks';
import { ProjectCard, ProjectCardSkeleton } from '@/components/project/ProjectCard';
import { ActiveProjectRow } from './ActiveProjectRow';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { LoadingRegion } from '@/components/ui/Skeleton';
import { formatCount, formatRelativeTime } from '@/lib/format';
import { jobStatusDisplay } from '@/lib/status';

/**
 * The dashboard (Phase 9 rule 7).
 *
 * Every section is a **bounded, filtered** query — never a full dataset. The
 * five reads below are all `limit`-capped and server-filtered, so the cost of
 * this page does not grow with the size of the workspace.
 *
 * Progress bars appear only in the "In production" section, where the set is
 * small and live progress is what the user is actually here for. The recent
 * grid deliberately shows status and next step instead: `GET /books` cannot
 * embed stage progress, and one progress request per card would be a request
 * amplification for decoration (GAP-2).
 */

/** The `Book.status` values that mean a worker is doing something right now. */
const ACTIVE_STATUSES = 'PARSING,ANALYZING,SCRIPTING,GENERATING,ASSEMBLING';

export function DashboardView() {
  const recent = useBookList({ limit: 6 });
  const active = useBookList({ status: ACTIVE_STATUSES, limit: 5 });
  const review = useBookList({ status: 'NEEDS_REVIEW', limit: 5 });
  const ready = useBookList({ status: 'COMPLETED', limit: 4 });
  const failedJobs = useJobs({ status: 'FAILED,DEAD_LETTERED', limit: 5 });
  const quotas = useQuotas();

  const hasAnyProject = (recent.data?.data.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            Studio
          </h1>
          <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
            Your audiobook productions, and what each one needs next.
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          New project
        </Link>
      </header>

      {/* --- Needs attention ------------------------------------------------ */}
      {(review.data?.data.length ?? 0) > 0 || (failedJobs.data?.data.length ?? 0) > 0 ? (
        <section aria-labelledby="attention-heading" className="space-y-3">
          <h2
            id="attention-heading"
            className="text-[13px] font-semibold tracking-wide text-[var(--text-muted)] uppercase"
          >
            Needs your attention
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {(review.data?.data.length ?? 0) > 0 ? (
              <Panel className="overflow-hidden">
                <PanelHeader
                  title="Waiting on a review decision"
                  description="Flagged passages are advisory — generation is not blocked, but a human decision improves the result."
                />
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {review.data?.data.map((book) => (
                    <li key={book.id}>
                      <Link
                        href={`/projects/${book.id}/review`}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-[var(--panel-raised)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                          {book.title}
                        </span>
                        <StatusBadge label="Review" tone="warning" size="sm" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {(failedJobs.data?.data.length ?? 0) > 0 ? (
              <Panel className="overflow-hidden">
                <PanelHeader
                  title="Failed work"
                  description="Jobs that stopped with an error, or exhausted their retries."
                />
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {failedJobs.data?.data.map((job) => {
                    const display = jobStatusDisplay(job.status);
                    return (
                      <li key={job.id} className="px-5 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-[13px] text-[var(--text-primary)]">
                              {job.type}
                            </p>
                            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                              {formatRelativeTime(job.completed_at ?? job.created_at)}
                              {job.error ? ` · ${job.error.code}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusBadge label={display.label} tone={display.tone} size="sm" />
                            {job.book_id ? (
                              <Link
                                href={`/projects/${job.book_id}/jobs`}
                                className="text-[12px] font-semibold text-[var(--accent-text)] hover:underline"
                              >
                                Open
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* --- In production -------------------------------------------------- */}
      <section aria-labelledby="active-heading" className="space-y-3">
        <h2
          id="active-heading"
          className="text-[13px] font-semibold tracking-wide text-[var(--text-muted)] uppercase"
        >
          In production
        </h2>
        {active.isPending ? (
          <LoadingRegion label="Loading active productions">
            <Panel className="space-y-3 p-5">
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-2.5 w-full" />
            </Panel>
          </LoadingRegion>
        ) : active.isError ? (
          <ErrorState error={active.error} onRetry={() => void active.refetch()} />
        ) : active.data && active.data.data.length > 0 ? (
          <Panel className="divide-y divide-[var(--border-subtle)] overflow-hidden">
            {active.data.data.map((book) => (
              <ActiveProjectRow key={book.id} book={book} />
            ))}
          </Panel>
        ) : (
          <Panel>
            <EmptyState
              title="Nothing is generating right now"
              description="When a project is reading, analysing, directing, or rendering audio, it appears here with live progress."
              className="py-10"
            />
          </Panel>
        )}
      </section>

      {/* --- Recent projects ------------------------------------------------- */}
      <section aria-labelledby="recent-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="recent-heading"
            className="text-[13px] font-semibold tracking-wide text-[var(--text-muted)] uppercase"
          >
            Recent projects
          </h2>
          <Link
            href="/projects"
            className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
          >
            All projects
          </Link>
        </div>

        {recent.isPending ? (
          <LoadingRegion label="Loading projects">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
            </div>
          </LoadingRegion>
        ) : recent.isError ? (
          <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
        ) : hasAnyProject ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {recent.data?.data.map((book) => <ProjectCard key={book.id} book={book} />)}
          </div>
        ) : (
          <Panel>
            <EmptyState
              title="No audiobooks yet"
              description="Start by creating a project and uploading a PDF or EPUB. The studio reads the book, finds its characters, casts voices, and produces a narrated audiobook."
              action={
                <Link href="/projects/new">
                  <Button variant="primary" size="lg">
                    Create your first audiobook
                  </Button>
                </Link>
              }
            />
          </Panel>
        )}
      </section>

      {/* --- Finished --------------------------------------------------------- */}
      {(ready.data?.data.length ?? 0) > 0 ? (
        <section aria-labelledby="ready-heading" className="space-y-3">
          <h2
            id="ready-heading"
            className="text-[13px] font-semibold tracking-wide text-[var(--text-muted)] uppercase"
          >
            Finished audiobooks
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {ready.data?.data.map((book) => <ProjectCard key={book.id} book={book} />)}
          </div>
        </section>
      ) : null}

      {/* --- Quotas ----------------------------------------------------------- */}
      {quotas.data && quotas.data.quotas?.length > 0 ? (
        <section aria-labelledby="quota-heading">
          <Panel className="overflow-hidden">
            <PanelHeader
              title={<span id="quota-heading">Workspace allowance</span>}
              description={
                quotas.data.degraded
                  ? 'Usage figures are unavailable right now, so only the limits are shown. This does not affect your ability to work.'
                  : undefined
              }
            />
            <dl className="grid gap-px bg-[var(--border-subtle)] sm:grid-cols-2 lg:grid-cols-4">
              {quotas.data.quotas.map((quota) => (
                <div key={quota.dimension} className="bg-[var(--panel)] px-5 py-4">
                  <dt className="text-[12px] text-[var(--text-muted)]">
                    {quota.dimension.replace(/_/g, ' ')}
                  </dt>
                  <dd className="mt-1 font-mono text-sm tabular-nums text-[var(--text-primary)]">
                    {/* `used: null` is "unknown", never zero. */}
                    {quota.used === null ? '—' : formatCount(quota.used)}
                    <span className="text-[var(--text-muted)]">
                      {' / '}
                      {quota.limit === null ? 'unlimited' : formatCount(quota.limit)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        </section>
      ) : null}
    </div>
  );
}
