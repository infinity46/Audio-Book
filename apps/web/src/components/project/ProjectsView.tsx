'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useBookList } from '@/lib/query/hooks';
import { useCursorPagination } from '@/lib/hooks/useCursorPagination';
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard';
import { Panel } from '@/components/ui/Panel';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import { LoadingRegion } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * The project library (Phase 9 rules 115–118).
 *
 * **Filtering** is server-side on `Book.status`, which is the one filter
 * `GET /books` accepts (plus `include_deleted`). **Search and sorting are not
 * offered**, because the endpoint supports neither: no `q`/title parameter and
 * no `sort` allowlist exist, and the ordering is fixed at `created_at:desc`.
 * Rule 161 forbids building a control for a capability that does not exist, and
 * rule 163 forbids faking it by fetching every page and filtering in the
 * browser — which on a tenant-wide collection would be unbounded. The gap is
 * recorded as GAP-6 rather than papered over.
 */

const FILTERS: { id: string; label: string; status?: string; includeDeleted?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'In production', status: 'PARSING,ANALYZING,SCRIPTING,GENERATING,ASSEMBLING' },
  { id: 'review', label: 'Needs review', status: 'NEEDS_REVIEW' },
  { id: 'ready', label: 'Ready', status: 'COMPLETED' },
  { id: 'attention', label: 'Failed or cancelled', status: 'FAILED,CANCELLED' },
  { id: 'draft', label: 'Not started', status: 'CREATED,UPLOADED' },
  { id: 'deleted', label: 'Deleted', includeDeleted: true },
];

const PAGE_SIZE = 24;

export function ProjectsView() {
  const [filterId, setFilterId] = useState('all');
  const pagination = useCursorPagination();
  const filter = FILTERS.find((entry) => entry.id === filterId) ?? FILTERS[0]!;

  // A cursor is meaningless against a different filter — restart on change.
  useEffect(() => {
    pagination.reset();
    // `reset` is a stable callback, so this runs on a filter change only.
  }, [filterId, pagination.reset]);

  const query = useBookList({
    status: filter.status,
    includeDeleted: filter.includeDeleted,
    limit: PAGE_SIZE,
    cursor: pagination.cursor,
  });

  const books = query.data?.data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            Projects
          </h1>
          <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
            Every book in this workspace, newest first.
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--text-inverse)] hover:bg-[var(--accent-hover)]"
        >
          New project
        </Link>
      </header>

      <div role="group" aria-label="Filter projects" className="flex flex-wrap gap-2">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={filterId === entry.id}
            onClick={() => setFilterId(entry.id)}
            className={cn(
              'rounded-[var(--radius-pill)] border px-3 py-1.5 text-[13px] font-medium transition-colors',
              filterId === entry.id
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]'
                : 'border-[var(--border-subtle)] bg-[var(--panel)] text-[var(--text-secondary)] hover:bg-[var(--panel-raised)]',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {filter.includeDeleted ? (
        <Notice tone="info" title="Deleted projects">
          Deleted projects are hidden from the other views. Restore a project to bring it back
          exactly as it was, or delete it permanently — which cannot be undone.
        </Notice>
      ) : null}

      {query.isPending ? (
        <LoadingRegion label="Loading projects">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        </LoadingRegion>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : books.length === 0 ? (
        <Panel>
          <EmptyState
            title={filterId === 'all' ? 'No audiobooks yet' : 'Nothing matches this filter'}
            description={
              filterId === 'all'
                ? 'Create a project and upload a PDF or EPUB to begin.'
                : 'Try a different filter, or clear it to see everything in the workspace.'
            }
            action={
              filterId === 'all' ? (
                <Link href="/projects/new">
                  <Button variant="primary" size="lg">
                    Create audiobook
                  </Button>
                </Link>
              ) : (
                <Button onClick={() => setFilterId('all')}>Show all projects</Button>
              )
            }
          />
        </Panel>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {books.map((book) => (
              <ProjectCard key={book.id} book={book} />
            ))}
          </div>
          <Panel className="overflow-hidden">
            <Pagination
              label="Project pages"
              shownCount={books.length}
              total={query.data?.page.total ?? null}
              hasPrevious={pagination.hasPrevious}
              hasNext={Boolean(query.data?.page.has_more)}
              loading={query.isFetching}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(query.data?.page.next_cursor ?? null)}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
