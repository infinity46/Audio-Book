'use client';

import Link from 'next/link';
import { useProject } from './ProjectContext';
import { StageProgressList } from './StageProgressList';
import { useAudiobookProject, useCastingState, useChapters, useCharacters } from '@/lib/query/hooks';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatCount, formatDuration, formatEstimate, formatLanguage } from '@/lib/format';
import { generationStatusDisplay } from '@/lib/status';

/**
 * Project home (Phase 9 rules 19, 168).
 *
 * Answers the four questions the brief poses, in this order: what state is this
 * in, how far has it got, what needs me, and is there an audiobook yet.
 */
export function ProjectOverview() {
  const { bookId, book, progress } = useProject();

  // These reads are cheap and are already cached by the tabs that own them.
  const chapters = useChapters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const characters = useCharacters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const casting = useCastingState(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const audiobook = useAudiobookProject(bookId);

  const estimate = progress ? formatEstimate(progress.estimate) : null;
  const audiobookStatus = audiobook.data
    ? generationStatusDisplay(audiobook.data.generation_status)
    : null;

  return (
    <div className="space-y-6">
      {progress?.degraded ? (
        <Notice tone="warning" title="Some figures are unavailable">
          The server reported this reading as incomplete
          {progress.degraded_reasons.length > 0
            ? ` (${progress.degraded_reasons.join(', ').toLowerCase().replace(/_/g, ' ')})`
            : ''}
          . What is shown is accurate; some of it may be missing.
        </Notice>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel className="overflow-hidden">
            <PanelHeader
              title="Production progress"
              description={estimate ?? undefined}
              actions={
                progress && progress.overall_progress !== null ? (
                  <span className="font-mono text-sm tabular-nums text-[var(--text-secondary)]">
                    {Math.round(progress.overall_progress * 100)}%
                  </span>
                ) : null
              }
            />
            {progress ? (
              <>
                <div className="px-5 pt-4">
                  <ProgressBar
                    value={progress.overall_progress}
                    label="Overall progress"
                    hideLabel
                  />
                  <p className="mt-2 text-[12px] text-[var(--text-muted)]">
                    Averaged over the stages whose totals are known. Stages that have not started
                    are not counted.
                  </p>
                </div>
                <div className="mt-2">
                  <StageProgressList stages={progress.stages} />
                </div>
              </>
            ) : (
              <PanelBody>
                <SkeletonText lines={5} />
              </PanelBody>
            )}
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader
              title="Audiobook"
              actions={
                audiobookStatus ? (
                  <StatusBadge
                    label={audiobookStatus.label}
                    tone={audiobookStatus.tone}
                    active={audiobookStatus.active}
                    description={audiobookStatus.description}
                    size="sm"
                  />
                ) : null
              }
            />
            <PanelBody>
              {audiobook.isPending ? (
                <SkeletonText lines={2} />
              ) : audiobook.data ? (
                <>
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Stat
                      label="Chapters assembled"
                      value={`${formatCount(audiobook.data.totals.chapters_assembled)} of ${formatCount(audiobook.data.totals.chapters)}`}
                    />
                    <Stat
                      label="Duration"
                      value={formatDuration(audiobook.data.totals.duration_ms) ?? '—'}
                    />
                    <Stat
                      label="Versions"
                      value={
                        audiobook.data.version_count > 0
                          ? `v${audiobook.data.current_version ?? '?'} of ${formatCount(audiobook.data.version_count)}`
                          : 'None yet'
                      }
                    />
                  </dl>
                  {audiobook.data.generation_status === 'STALE' ? (
                    <Notice
                      className="mt-4"
                      tone="warning"
                      title="This audiobook is out of date"
                    >
                      The book or its story data changed after this version was assembled.
                      Reassembling produces a new version; the existing one stays downloadable and
                      unchanged.
                    </Notice>
                  ) : null}
                  {audiobook.data.current_audiobook_id ? (
                    <Link
                      href={`/projects/${bookId}/audiobook`}
                      className="mt-4 inline-block text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
                    >
                      Open the audiobook →
                    </Link>
                  ) : null}
                </>
              ) : null}
            </PanelBody>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel className="overflow-hidden">
            <PanelHeader title="Book" />
            <PanelBody>
              <dl className="space-y-3">
                <Row label="Language" value={formatLanguage(book?.language)} />
                <Row
                  label="Chapters"
                  value={chapters.data ? formatCount(chapters.data.length) : '—'}
                />
                <Row
                  label="Characters"
                  value={characters.data ? formatCount(characters.data.length) : '—'}
                />
                <Row
                  label="Speaking characters"
                  value={
                    casting.data ? formatCount(casting.data.speaking_character_count) : '—'
                  }
                />
                <Row label="Pipeline version" value={book?.pipeline_version ?? '—'} mono />
              </dl>
              <Link
                href={`/projects/${bookId}/book`}
                className="mt-4 inline-block text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
              >
                Open the book →
              </Link>
            </PanelBody>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader title="Casting" />
            <PanelBody>
              {casting.isPending ? (
                <SkeletonText lines={3} />
              ) : casting.data ? (
                <>
                  <dl className="space-y-3">
                    <Row
                      label="Voices assigned"
                      value={`${formatCount(casting.data.assigned_count)} of ${formatCount(casting.data.speaking_character_count)}`}
                    />
                    <Row label="Approved" value={formatCount(casting.data.approved_count)} />
                  </dl>
                  {casting.data.ready_for_generation ? (
                    <p className="mt-4 text-[13px] text-[var(--tone-success)]">
                      Casting is complete — audio generation can start.
                    </p>
                  ) : (
                    <Notice className="mt-4" tone="warning" title="Casting is not complete">
                      {formatCount(casting.data.blocking.length)} character
                      {casting.data.blocking.length === 1 ? '' : 's'} still need a usable voice.
                      Audio generation is refused until every speaking character resolves to an
                      approved voice.
                    </Notice>
                  )}
                  <Link
                    href={`/projects/${bookId}/voices`}
                    className="mt-4 inline-block text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
                  >
                    Open casting →
                  </Link>
                </>
              ) : null}
            </PanelBody>
          </Panel>

          {progress && progress.active_job_ids.length > 0 ? (
            <Panel className="overflow-hidden">
              <PanelHeader
                title="Running now"
                description={`${formatCount(progress.active_job_ids.length)} active job${progress.active_job_ids.length === 1 ? '' : 's'}`}
              />
              <PanelBody>
                <Link
                  href={`/projects/${bookId}/jobs`}
                  className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
                >
                  Open the activity log →
                </Link>
              </PanelBody>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[13px] text-[var(--text-muted)]">{label}</dt>
      <dd
        className={`text-[13px] font-medium text-[var(--text-primary)] ${mono ? 'font-mono text-[12px]' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
