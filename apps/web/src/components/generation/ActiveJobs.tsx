'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCancelJob } from '@/lib/query/hooks';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatRelativeTime } from '@/lib/format';
import { isCancellable, jobStatusDisplay } from '@/lib/status';
import type { Job } from '@/lib/api/types';

/**
 * Running work, and cancellation (Phase 9 rules 49, 50).
 *
 * Cancellation is **cooperative, never preemptive**. `POST .../cancellation`
 * always returns `200` and is always idempotent, but its response carries the
 * distinction that matters: `effective: false` on a `RUNNING` job means the
 * request was recorded and the work has **not stopped** — a worker observes the
 * flag at its next job boundary and exits then. `api-usage-guide.md` §9 is
 * blunt about it: "a UI that shows 'cancelled' the instant the call returns is
 * lying about a GPU that is still running."
 *
 * So this component reports "Cancelling…" until the job's own status becomes
 * `CANCELLED`, and the confirmation states plainly that finished work is kept.
 */
export function ActiveJobs({
  bookId,
  jobs,
  loading,
}: {
  bookId: string;
  jobs: Job[];
  loading: boolean;
}) {
  const cancel = useCancelJob();
  const [confirming, setConfirming] = useState<Job | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  const live = jobs.filter((job) => isCancellable(job.status));

  async function requestCancellation(): Promise<void> {
    if (!confirming) return;
    const jobId = confirming.id;
    try {
      await cancel.mutateAsync({ jobId, reason: 'Cancelled from the studio.' });
      setRequested((current) => new Set(current).add(jobId));
    } finally {
      setConfirming(null);
    }
  }

  if (loading) {
    return (
      <Panel>
        <PanelBody>
          <SkeletonText lines={2} />
        </PanelBody>
      </Panel>
    );
  }

  if (live.length === 0) return null;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Running work"
        description="Jobs the studio is currently coordinating for this project."
        actions={
          <Link
            href={`/projects/${bookId}/jobs`}
            className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
          >
            Activity log
          </Link>
        }
      />

      {cancel.isError ? (
        <PanelBody>
          <ErrorState error={cancel.error} compact />
        </PanelBody>
      ) : null}

      <ul className="divide-y divide-[var(--border-subtle)]">
        {live.map((job) => {
          const display = jobStatusDisplay(job.status);
          // A request has been made and the worker has not acknowledged it yet.
          const cancelling =
            (requested.has(job.id) || job.cancellation?.requested) && job.status !== 'CANCELLED';
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[13px] text-[var(--text-primary)]">
                  {job.type}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                  Started {formatRelativeTime(job.started_at ?? job.created_at)}
                  {job.attempt_count > 1 ? ` · attempt ${job.attempt_count}` : ''}
                </p>
              </div>

              <StatusBadge
                label={cancelling ? 'Cancelling' : display.label}
                tone={cancelling ? 'warning' : display.tone}
                active={display.active && !cancelling}
                description={
                  cancelling
                    ? 'Cancellation has been requested. The worker stops at its next safe point — the work may still be running until then.'
                    : display.description
                }
                size="sm"
              />

              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(job)}
                disabled={Boolean(cancelling) || cancel.isPending}
                disabledReason={cancelling ? 'Cancellation has already been requested.' : undefined}
              >
                Cancel
              </Button>
            </li>
          );
        })}
      </ul>

      {[...requested].some((id) => jobs.find((job) => job.id === id)?.status !== 'CANCELLED') ? (
        <PanelBody className="border-t border-[var(--border-subtle)]">
          <Notice tone="info" title="Cancellation requested">
            Work stops at the next safe point rather than being killed mid-task, so a job may keep
            running for a while yet. This view updates when it actually stops.
          </Notice>
        </PanelBody>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Cancel this work?"
        destructive
        consequence={
          <>
            Everything already finished is <strong>kept</strong> — completed passages, chapters, and
            audio stay exactly as they are, and starting again resumes from them rather than
            redoing them. The worker stops at its next safe point, so this may not take effect
            immediately.
          </>
        }
        confirmLabel="Request cancellation"
        busy={cancel.isPending}
        onConfirm={() => void requestCancellation()}
      />
    </Panel>
  );
}
