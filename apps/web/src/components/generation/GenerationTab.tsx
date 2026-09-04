'use client';

import { useMemo, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import {
  useAudioScript,
  useBookFiles,
  useCapabilities,
  useCastingState,
  useJobs,
} from '@/lib/query/hooks';
import { buildGenerationPlan } from '@/lib/generation';
import { GenerationSettings, type OutputSettings } from './GenerationSettings';
import { StageRunner } from './StageRunner';
import { ActiveJobs } from './ActiveJobs';
import { StageProgressList } from '@/components/project/StageProgressList';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { EmptyState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatCount, formatEstimate } from '@/lib/format';
import { STAGE_LABELS } from '@/lib/status';

/**
 * The generation workspace (Phase 9 rules 34–50, 113).
 *
 * Three things live here, in the order they matter: what is running now, what
 * to run next, and how the output should be configured. It is the persistent
 * status surface for a long-running production — leaving the page and coming
 * back reconstructs everything from the server (rules 45, 108).
 */
export function GenerationTab() {
  const { bookId, book, progress, streaming } = useProject();
  const casting = useCastingState(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const audioScript = useAudioScript(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const files = useBookFiles(bookId);
  const capabilities = useCapabilities();
  const jobs = useJobs({ bookId, limit: 10 }, { streaming });

  const [settings, setSettings] = useState<OutputSettings>({
    deliveryFormats: ['M4B'],
    priority: 'NORMAL',
    force: false,
    allowPartialPreview: false,
  });

  const plan = useMemo(
    () =>
      buildGenerationPlan({
        progress,
        casting: casting.data,
        audioScript: audioScript.data,
      }),
    [progress, casting.data, audioScript.data],
  );

  const estimate = progress ? formatEstimate(progress.estimate) : null;
  const runningStage = progress?.stages.find(
    (stage) => stage.status === 'RUNNING' || stage.status === 'QUEUED' || stage.status === 'VALIDATING',
  );
  const failedStages = progress?.stages.filter((stage) => stage.status === 'FAILED') ?? [];
  const totalFailedUnits = progress?.stages.reduce((sum, s) => sum + s.failed_units, 0) ?? 0;

  if (!book) {
    return (
      <Panel>
        <PanelBody>
          <SkeletonText lines={6} />
        </PanelBody>
      </Panel>
    );
  }

  if (!book.current_book_version_id && (files.data?.data.length ?? 0) === 0) {
    return (
      <Panel>
        <EmptyState
          title="Nothing to generate yet"
          description="Attach a source book first. Once it has been read and analysed, this is where you configure and run the production."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {/* --- Live status: the first thing, whenever anything is happening ---- */}
      {runningStage ? (
        <Panel className="overflow-hidden border-[var(--tone-progress)]/30">
          <PanelHeader
            title={STAGE_LABELS[runningStage.stage]}
            description={estimate ?? 'The studio has not measured a completion rate yet.'}
          />
          <PanelBody>
            <ProgressBar
              value={runningStage.progress}
              label={STAGE_LABELS[runningStage.stage]}
              completedUnits={runningStage.completed_units}
              totalUnits={runningStage.total_units}
              unitNoun={{ one: 'unit', many: 'units' }}
              hideLabel
            />
            <p className="mt-3 text-[12px] text-[var(--text-muted)]">
              You can leave this page. Progress is kept on the server and this view rebuilds itself
              from it.
            </p>
          </PanelBody>
        </Panel>
      ) : null}

      {failedStages.length > 0 || totalFailedUnits > 0 ? (
        <Notice
          tone="danger"
          title={
            failedStages.length > 0
              ? `${failedStages.map((s) => STAGE_LABELS[s.stage]).join(', ')} failed`
              : `${formatCount(totalFailedUnits)} unit${totalFailedUnits === 1 ? '' : 's'} failed`
          }
        >
          Failed work does not stop what already succeeded — completed output is kept. To try again,
          re-run the affected stage below; that creates fresh jobs and produces a new version rather
          than overwriting anything. The activity log shows the error the workers reported.
        </Notice>
      ) : null}

      <ActiveJobs bookId={bookId} jobs={jobs.data?.data ?? []} loading={jobs.isPending} />

      {/* --- What to run next --------------------------------------------- */}
      <StageRunner
        bookId={bookId}
        plan={plan}
        settings={settings}
        chapterCountHint={progress?.stages.find((s) => s.stage === 'assembly')?.total_units ?? null}
        scriptChunkCount={audioScript.data?.chunk_count ?? null}
        bookTitle={book.title}
        castingSummary={casting.data ?? null}
        deliveryFormatsAvailable={capabilities.data?.delivery_formats ?? ['M4B']}
      />

      {/* --- Output configuration ------------------------------------------ */}
      <GenerationSettings
        value={settings}
        onChange={setSettings}
        capabilities={capabilities.data ?? null}
        capabilitiesLoading={capabilities.isPending}
      />

      {/* --- Full pipeline state -------------------------------------------- */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Pipeline"
          description="Each stage reports what it actually measured. A stage with no known total shows as preparing rather than as 0%."
        />
        {progress ? (
          <StageProgressList stages={progress.stages} />
        ) : (
          <PanelBody>
            <SkeletonText lines={5} />
          </PanelBody>
        )}
      </Panel>
    </div>
  );
}
