'use client';

import { useState } from 'react';
import { useBookFiles, useStartStage } from '@/lib/query/hooks';
import { newIdempotencyKey } from '@/lib/api/client';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { formatCount } from '@/lib/format';
import { STAGE_LABELS } from '@/lib/status';
import type { GenerationPlan, StagePlanEntry } from '@/lib/generation';
import type { OutputSettings } from './GenerationSettings';
import type { CastingState, StageCommandBody, StageName } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * Running a pipeline stage (Phase 9 rules 36–39, 47, 48).
 *
 * The confirmation carries a real **configuration summary** (rule 36) and a
 * real statement of cost (rule 38) — and deliberately promises no completion
 * time, because the API declines to predict one and so does this UI (rule 175).
 *
 * `Idempotency-Key` is minted once per confirmed intent and reused if the same
 * confirmation is retried, so a network timeout cannot start the same expensive
 * generation twice. The button is additionally disabled while the request is in
 * flight (rule 39) — belt to the server's suspenders, not a substitute for them.
 *
 * There is no "Retry" control anywhere here, by design: `api-specification.md`
 * §16.18 defines no retry endpoint, and a user-visible "try again" **is** a
 * scoped stage command. Re-running a stage is that command (rule 48).
 */
export function StageRunner({
  bookId,
  plan,
  settings,
  bookTitle,
  scriptChunkCount,
  chapterCountHint,
  castingSummary,
  deliveryFormatsAvailable,
}: {
  bookId: string;
  plan: GenerationPlan;
  settings: OutputSettings;
  bookTitle: string;
  scriptChunkCount: number | null;
  chapterCountHint: number | null;
  castingSummary: CastingState | null;
  deliveryFormatsAvailable: string[];
}) {
  const { toast } = useToast();
  const files = useBookFiles(bookId);
  const [confirming, setConfirming] = useState<StagePlanEntry | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ stage: StageName; planned: number | null } | null>(
    null,
  );

  // One mutation per stage so each carries its own path; only the confirmed one
  // is ever invoked.
  const runners: Record<StageName, ReturnType<typeof useStartStage>> = {
    ingestion: useStartStage(bookId, 'ingestion'),
    analysis: useStartStage(bookId, 'analysis'),
    director: useStartStage(bookId, 'director'),
    tts: useStartStage(bookId, 'tts'),
    assembly: useStartStage(bookId, 'assembly'),
  };

  const active = confirming ? runners[confirming.stage] : null;
  const anyError = Object.values(runners).find((runner) => runner.isError)?.error;
  const anyPending = Object.values(runners).some((runner) => runner.isPending);

  const openConfirm = (entry: StagePlanEntry) => {
    setAccepted(null);
    // Minted once per intent — reused if this same confirmation is retried.
    setIdempotencyKey(newIdempotencyKey());
    setConfirming(entry);
  };

  const run = async () => {
    if (!confirming || !idempotencyKey) return;
    const body = buildBody(confirming.stage, settings, files.data?.data[0]?.id);
    if (!body) return;
    try {
      const result = await runners[confirming.stage].mutateAsync({ body, idempotencyKey });
      setAccepted({
        stage: confirming.stage,
        planned: result?.accepted?.planned_unit_count ?? null,
      });
      setConfirming(null);
      toast({
        message: `${STAGE_LABELS[confirming.stage]} has been queued.`,
        tone: 'success',
      });
    } catch {
      // Rendered inside the dialog; the intent (and its key) is kept so the
      // user can correct the cause and confirm again with the same key.
    }
  };

  const primary = plan.next;
  const runningEntry = plan.entries.find((entry) => entry.running) ?? null;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Production steps"
        description="The studio runs one stage at a time. Each step uses what the previous one produced."
      />

      <ol className="divide-y divide-[var(--border-subtle)]">
        {plan.entries.map((entry) => {
          const isPrimary = primary?.stage === entry.stage;
          return (
            <li key={entry.stage} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                  {STAGE_LABELS[entry.stage]}
                </p>
                {entry.blockedReason ? (
                  <p className="mt-0.5 text-[12px] text-[var(--tone-warning)]">
                    {entry.blockedReason}
                  </p>
                ) : entry.complete ? (
                  <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                    Finished. Running it again produces a new version and keeps the existing one.
                  </p>
                ) : null}
              </div>

              {entry.running ? (
                <StatusBadge label="Running" tone="progress" active size="sm" />
              ) : entry.complete ? (
                <StatusBadge label="Complete" tone="success" size="sm" />
              ) : null}

              <Button
                size="sm"
                variant={isPrimary ? 'primary' : 'secondary'}
                onClick={() => openConfirm(entry)}
                disabled={
                  Boolean(entry.blockedReason) ||
                  entry.running ||
                  anyPending ||
                  Boolean(runningEntry)
                }
                disabledReason={
                  entry.blockedReason ??
                  (entry.running
                    ? 'This stage is already running.'
                    : runningEntry
                      ? `Wait for ${STAGE_LABELS[runningEntry.stage].toLowerCase()} to finish.`
                      : undefined)
                }
              >
                {entry.complete ? 'Run again' : entry.actionLabel}
              </Button>
            </li>
          );
        })}
      </ol>

      {accepted ? (
        <PanelBody className="border-t border-[var(--border-subtle)]">
          <Notice tone="info" title="Queued">
            {STAGE_LABELS[accepted.stage]} has been accepted and queued
            {accepted.planned !== null
              ? `, with ${formatCount(accepted.planned)} unit${accepted.planned === 1 ? '' : 's'} of work planned`
              : ''}
            . That means the request was validated and the work was enqueued — not that any of it has
            happened yet. Progress appears above as workers pick it up.
          </Notice>
        </PanelBody>
      ) : null}

      {anyError && !confirming ? (
        <PanelBody className="border-t border-[var(--border-subtle)]">
          <ErrorState error={anyError} compact />
        </PanelBody>
      ) : null}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
            setIdempotencyKey(null);
          }
        }}
        size="md"
        busy={active?.isPending ?? false}
        title={confirming ? `${confirming.actionLabel}?` : ''}
        description={confirming ? consequenceFor(confirming, scriptChunkCount) : undefined}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(null);
                setIdempotencyKey(null);
              }}
              disabled={active?.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void run()}
              loading={active?.isPending ?? false}
            >
              {confirming?.actionLabel ?? 'Run'}
            </Button>
          </>
        }
      >
        {confirming ? (
          <div className="space-y-4">
            <dl className="space-y-2 rounded-[var(--radius-control)] bg-[var(--panel-sunken)] px-4 py-3">
              <SummaryRow label="Book" value={bookTitle} />
              {confirming.stage === 'tts' ? (
                <>
                  <SummaryRow
                    label="Passages to perform"
                    value={
                      scriptChunkCount !== null
                        ? formatCount(scriptChunkCount)
                        : 'Not known until the script is read'
                    }
                  />
                  <SummaryRow
                    label="Character voices"
                    value={
                      castingSummary
                        ? `${formatCount(castingSummary.approved_count)} of ${formatCount(castingSummary.speaking_character_count)} approved`
                        : 'Unknown'
                    }
                  />
                </>
              ) : null}
              {confirming.stage === 'assembly' ? (
                <>
                  <SummaryRow
                    label="Chapters"
                    value={chapterCountHint !== null ? formatCount(chapterCountHint) : 'Unknown'}
                  />
                  <SummaryRow
                    label="Delivery formats"
                    value={settings.deliveryFormats
                      .filter((format) => deliveryFormatsAvailable.includes(format))
                      .join(', ')}
                  />
                </>
              ) : null}
              <SummaryRow label="Queue priority" value={settings.priority.toLowerCase()} />
              <SummaryRow
                label="Redo existing output"
                value={settings.force ? 'Yes — a new version will be produced' : 'No — reuse valid output'}
              />
            </dl>

            {active?.isError ? (
              <ErrorState
                error={active.error}
                compact
                secondaryAction={
                  active.error instanceof ApiError && active.error.code === 'CASTING_INCOMPLETE' ? (
                    <a
                      href={`/projects/${bookId}/voices`}
                      className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
                    >
                      Open casting
                    </a>
                  ) : undefined
                }
              />
            ) : null}

            <p className="text-[12px] text-[var(--text-muted)]">
              The studio cannot promise when this will finish. Where it has measured a rate, it shows
              an estimate; where it has not, it says so rather than guessing.
            </p>
          </div>
        ) : null}
      </Dialog>
    </Panel>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[13px] font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

/** Rule 38 — say what this actually does, without implying a duration. */
function consequenceFor(entry: StagePlanEntry, scriptChunkCount: number | null): string {
  switch (entry.stage) {
    case 'tts':
      return scriptChunkCount !== null
        ? `This generates narration for the whole book — ${formatCount(scriptChunkCount)} passages. It is the most expensive step in the production.`
        : 'This generates narration for the whole book. It is the most expensive step in the production.';
    case 'assembly':
      return 'This joins every chapter, masters the loudness, and packages the audiobook in the formats selected below.';
    case 'director':
      return 'This writes a performance script for the whole book — who speaks each line, and how.';
    case 'analysis':
      return 'This reads the whole book to find its characters, scenes, and dialogue.';
    default:
      return 'This extracts the text and structure from the source file.';
  }
}

function buildBody(
  stage: StageName,
  settings: OutputSettings,
  bookFileId: string | undefined,
): StageCommandBody | null {
  const priority = settings.priority;
  switch (stage) {
    case 'ingestion':
      // `request-ingestion.schema.json` accepts exactly `book_file_id`,
      // `force`, and `priority` — and rejects anything else. No `scope`.
      if (!bookFileId) return null;
      return { book_file_id: bookFileId, priority, force: settings.force };
    case 'analysis':
      // `mode` is required by the schema. INCREMENTAL reuses valid work;
      // REBUILD is what "redo existing output" means for this stage.
      return {
        scope: 'BOOK',
        mode: settings.force ? 'REBUILD' : 'INCREMENTAL',
        priority,
        force: settings.force,
      };
    case 'director':
      return { scope: 'BOOK', priority, force: settings.force };
    case 'tts':
      return { scope: 'BOOK', priority, force: settings.force };
    case 'assembly':
      return {
        scope: 'AUDIOBOOK',
        delivery_formats: settings.deliveryFormats,
        allow_partial_preview: settings.allowPartialPreview,
        priority,
        force: settings.force,
      };
    default:
      return null;
  }
}
