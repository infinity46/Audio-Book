'use client';

import { useEffect, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useJobs } from '@/lib/query/hooks';
import { useCursorPagination } from '@/lib/hooks/useCursorPagination';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Pagination } from '@/components/ui/Pagination';
import { Table, TableContainer, Td, Th, Tr } from '@/components/ui/Table';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { Select } from '@/components/ui/Field';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format';
import { jobStatusDisplay } from '@/lib/status';
import { cn } from '@/lib/cn';

/**
 * The activity log (Phase 9 rules 47, 48, 82).
 *
 * This is where a failure becomes actionable: what failed, what state it is in,
 * and whether the system will try again by itself. Three facts from the job
 * resource carry that, and all three come from the server:
 *
 *  - `error.retryable` / `error.terminal` — whether the system retries on its
 *    own. A `RETRYING` job carries `next_attempt_at`.
 *  - `DEAD_LETTERED` — the retry budget is spent; only an operator can replay
 *    it, and this UI says so rather than offering a button it cannot honour.
 *  - There is **no** user retry action here, by contract (§16.18). The
 *    user-visible "try again" is a scoped stage command on the Generation tab
 *    (rule 48), and that is where this screen points.
 */

const STATUS_FILTERS = [
  { value: '', label: 'Every job' },
  { value: 'QUEUED,RUNNING,RETRYING,BLOCKED', label: 'In flight' },
  { value: 'FAILED,DEAD_LETTERED', label: 'Failed' },
  { value: 'SUCCEEDED', label: 'Succeeded' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const PAGE_SIZE = 25;

export function JobsTab() {
  const { bookId, streaming } = useProject();
  const pagination = useCursorPagination();
  const [status, setStatus] = useState('');

  useEffect(() => {
    pagination.reset();
  }, [status, pagination.reset]);

  const jobs = useJobs(
    { bookId, status: status || undefined, limit: PAGE_SIZE, cursor: pagination.cursor },
    { streaming },
  );

  const rows = jobs.data?.data ?? [];

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Activity"
          description="Everything the studio has run for this project, newest first."
        />

        <div className="border-b border-[var(--border-subtle)] px-5 py-3">
          <label htmlFor="job-status" className="sr-only">
            Filter jobs by status
          </label>
          <Select
            id="job-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="max-w-xs"
          >
            {STATUS_FILTERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>

        {jobs.isPending ? (
          <PanelBody>
            <SkeletonText lines={6} />
          </PanelBody>
        ) : jobs.isError ? (
          <PanelBody>
            <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} compact />
          </PanelBody>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description={
              status
                ? 'No jobs match this filter.'
                : 'The studio has not run any work for this project yet.'
            }
          />
        ) : (
          <TableContainer label="Job history">
            <Table>
              <caption className="sr-only">
                Jobs run for this project, newest first, with status and any reported error.
              </caption>
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Finished</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => {
                  const display = jobStatusDisplay(job.status);
                  return (
                    <Tr key={job.id}>
                      <Td>
                        <span className="font-mono text-[13px] text-[var(--text-primary)]">
                          {job.type}
                        </span>
                        {job.attempt_count > 1 ? (
                          <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                            attempt {job.attempt_count}
                            {job.max_attempts ? ` of ${job.max_attempts}` : ''}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <StatusBadge
                          label={display.label}
                          tone={display.tone}
                          active={display.active}
                          description={display.description}
                          size="sm"
                        />
                      </Td>
                      <Td className="whitespace-nowrap">
                        <time
                          dateTime={job.started_at ?? job.created_at}
                          title={formatAbsoluteTime(job.started_at ?? job.created_at)}
                        >
                          {formatRelativeTime(job.started_at ?? job.created_at)}
                        </time>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {job.completed_at ? (
                          <time dateTime={job.completed_at} title={formatAbsoluteTime(job.completed_at)}>
                            {formatRelativeTime(job.completed_at)}
                          </time>
                        ) : (
                          <span className="text-[var(--text-muted)]">—</span>
                        )}
                      </Td>
                      <Td>
                        <JobDetail job={job} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableContainer>
        )}

        {rows.length > 0 ? (
          <Pagination
            label="Activity pages"
            shownCount={rows.length}
            total={jobs.data?.page.total ?? null}
            hasPrevious={pagination.hasPrevious}
            hasNext={Boolean(jobs.data?.page.has_more)}
            loading={jobs.isFetching}
            onPrevious={pagination.previous}
            onNext={() => pagination.next(jobs.data?.page.next_cursor ?? null)}
          />
        ) : null}
      </Panel>

      <Notice tone="info" title="How to try something again">
        There is no “retry” button here, by design. Re-running a stage from the Generation tab
        creates fresh work with full lineage and produces a new version — it never overwrites what
        already exists. A job marked <em>dead-lettered</em> has spent its automatic retries and can
        only be replayed by an operator.
      </Notice>
    </div>
  );
}

function JobDetail({
  job,
}: {
  job: {
    status: string;
    error: { code: string; message: string; retryable: boolean; terminal: boolean } | null;
    next_attempt_at: string | null;
    cancellation?: { requested: boolean; effective: boolean };
  };
}) {
  if (job.error) {
    return (
      <div className="max-w-sm">
        <p
          className={cn(
            'font-mono text-[12px]',
            job.error.terminal ? 'text-[var(--tone-danger)]' : 'text-[var(--tone-warning)]',
          )}
        >
          {job.error.code}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {job.error.message}
        </p>
        {job.status === 'RETRYING' && job.next_attempt_at ? (
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            The studio retries automatically — next attempt{' '}
            {formatRelativeTime(job.next_attempt_at)}.
          </p>
        ) : job.error.terminal ? (
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            This will not be retried automatically.
          </p>
        ) : null}
      </div>
    );
  }

  if (job.cancellation?.requested && !job.cancellation.effective && job.status !== 'CANCELLED') {
    return (
      <p className="max-w-sm text-[12px] text-[var(--tone-warning)]">
        Cancellation requested. The worker stops at its next safe point, so this may still be
        running.
      </p>
    );
  }

  return <span className="text-[12px] text-[var(--text-muted)]">—</span>;
}
