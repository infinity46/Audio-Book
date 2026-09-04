'use client';

import { ProgressBar } from '@/components/ui/ProgressBar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatCount, formatProgress } from '@/lib/format';
import { STAGE_LABELS, STAGE_UNIT_NOUNS, stageStatusDisplay } from '@/lib/status';
import type { StageProgress } from '@/lib/api/types';

/**
 * The five-stage pipeline view (Phase 9 rules 16, 40, 42).
 *
 * Segment-level detail is aggregated, never enumerated: a book can have tens of
 * thousands of TTS chunks, and rule 42 is explicit that they must not all be
 * rendered. What is shown per stage is exactly the server's own aggregate —
 * completed, total, failed, flagged — and `total_units: null` renders as
 * "preparing", not as zero.
 */
export function StageProgressList({ stages }: { stages: StageProgress[] }) {
  return (
    <ol className="divide-y divide-[var(--border-subtle)]">
      {stages.map((stage, index) => {
        const display = stageStatusDisplay(stage.status);
        const noun = STAGE_UNIT_NOUNS[stage.stage];
        return (
          <li key={stage.stage} className="px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--panel-sunken)] font-mono text-[11px] text-[var(--text-muted)]"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {STAGE_LABELS[stage.stage]}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {/*
                  The measurement, in words, next to the state. A running stage
                  whose denominator the server does not yet know reads
                  "Preparing…" — never "0%".
                */}
                {stage.status !== 'NOT_STARTED' ? (
                  <span className="font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
                    {formatProgress(stage.progress) ?? 'Preparing…'}
                  </span>
                ) : null}
                <StatusBadge
                  label={display.label}
                  tone={display.tone}
                  active={display.active}
                  description={display.description}
                  size="sm"
                />
              </div>
            </div>

            {stage.status !== 'NOT_STARTED' ? (
              <div className="mt-3 pl-9">
                <ProgressBar
                  value={stage.progress}
                  label={STAGE_LABELS[stage.stage]}
                  tone={display.tone === 'danger' ? 'danger' : display.tone === 'success' ? 'success' : 'progress'}
                  completedUnits={stage.completed_units}
                  totalUnits={stage.total_units}
                  unitNoun={noun}
                  size="sm"
                  hideLabel
                />
                {stage.failed_units > 0 || stage.flagged_units > 0 ? (
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                    {stage.failed_units > 0 ? (
                      <span className="text-[var(--tone-danger)]">
                        {formatCount(stage.failed_units)} failed
                      </span>
                    ) : null}
                    {stage.flagged_units > 0 ? (
                      <span className="text-[var(--tone-warning)]">
                        {formatCount(stage.flagged_units)} flagged for review
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
