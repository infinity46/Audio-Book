'use client';

import Link from 'next/link';
import { useBookEventStream } from '@/lib/query/useEventStream';
import { useBookProgress } from '@/lib/query/hooks';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { CoverArt } from '@/components/project/CoverArt';
import { formatEstimate } from '@/lib/format';
import { bookStatusDisplay, STAGE_LABELS, STAGE_UNIT_NOUNS } from '@/lib/status';
import type { Book } from '@/lib/api/types';

/**
 * One live production on the dashboard.
 *
 * Streams its own events and polls progress at the adaptive rate. The stage
 * shown is the one actually running — derived from the server's stage
 * projection, never from a client-side guess about pipeline order.
 */
export function ActiveProjectRow({ book }: { book: Book }) {
  const stream = useBookEventStream(book.id);
  const progress = useBookProgress(book.id, { streaming: stream.streaming });
  const status = bookStatusDisplay(progress.data?.book_status ?? book.status);

  const runningStage = progress.data?.stages.find(
    (stage) => stage.status === 'RUNNING' || stage.status === 'QUEUED' || stage.status === 'VALIDATING',
  );
  const estimate = progress.data ? formatEstimate(progress.data.estimate) : null;

  return (
    <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <CoverArt bookId={book.id} title={book.title} size="sm" />
        <div className="min-w-0 flex-1">
          <Link
            href={`/projects/${book.id}/generation`}
            className="block truncate text-sm font-semibold text-[var(--text-primary)] hover:underline"
          >
            {book.title}
          </Link>
          <p className="mt-0.5 truncate text-[12px] text-[var(--text-muted)]">
            {runningStage ? STAGE_LABELS[runningStage.stage] : status.description}
          </p>
        </div>
      </div>

      <div className="w-full sm:max-w-xs">
        <ProgressBar
          value={runningStage ? runningStage.progress : (progress.data?.overall_progress ?? null)}
          label={runningStage ? STAGE_LABELS[runningStage.stage] : 'Overall progress'}
          completedUnits={runningStage?.completed_units}
          totalUnits={runningStage?.total_units}
          unitNoun={runningStage ? STAGE_UNIT_NOUNS[runningStage.stage] : undefined}
          size="sm"
          hideLabel
        />
        {/*
          The ETA is shown only when the server measured one. `confidence: NONE`
          means it declined to guess, and the UI must not fill that in.
        */}
        {estimate ? (
          <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">{estimate}</p>
        ) : null}
      </div>

      <div className="shrink-0">
        <StatusBadge
          label={status.label}
          tone={status.tone}
          active={status.active}
          description={status.description}
          size="sm"
        />
      </div>
    </div>
  );
}
