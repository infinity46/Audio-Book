'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useAudiobookProject, useAudiobooks } from '@/lib/query/hooks';
import { AudiobookPlayer } from '@/components/audio/AudiobookPlayer';
import { DownloadButton } from './DownloadButton';
import { CoverArt } from '@/components/project/CoverArt';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatAbsoluteTime, formatBytes, formatCount, formatDuration, formatLanguage } from '@/lib/format';
import { generationStatusDisplay, humanizeEnum } from '@/lib/status';
import { cn } from '@/lib/cn';

/**
 * The finished audiobook (Phase 9 rules 66, 67, 68, 176, 182, 183).
 *
 * The two-step the API guide calls out is respected exactly: `GET .../audiobook`
 * returns an **`audiobook_project`** whose lifecycle field is
 * `generation_status`, and its `current_audiobook_id` points at an
 * **`audiobook`** whose own field is `status` and which reaches `READY`. They
 * are different objects with different vocabularies, and reading `status` on the
 * project finds nothing — a mistake a Phase 7 test actually made (F-25).
 *
 * Version history is read-only by construction (rule 68): superseded versions
 * offer playback and download and nothing else. There is no endpoint that could
 * mutate them, and this screen renders no control that implies one.
 */
export function AudiobookTab() {
  const { bookId, book } = useProject();
  const project = useAudiobookProject(bookId);
  const versions = useAudiobooks(bookId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (project.isError) {
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  }

  if (project.isPending) {
    return (
      <Panel>
        <PanelBody>
          <SkeletonText lines={6} />
        </PanelBody>
      </Panel>
    );
  }

  const projectState = project.data;
  const status = generationStatusDisplay(projectState.generation_status);
  const activeId = selectedId ?? projectState.current_audiobook_id;
  const audiobook = (versions.data ?? []).find((entry) => entry.id === activeId) ?? null;
  const isCurrent = audiobook?.id === projectState.current_audiobook_id;
  // Rule 182: the download action exists only for a READY artifact.
  const ready = audiobook?.status === 'READY';

  if (!projectState.current_audiobook_id) {
    return (
      <Panel>
        <EmptyState
          title="No audiobook has been assembled yet"
          description={
            projectState.totals.chapters_assembled > 0
              ? `${formatCount(projectState.totals.chapters_assembled)} of ${formatCount(projectState.totals.chapters)} chapters have audio. Assembling joins them into a finished audiobook.`
              : 'Once audio has been generated for the book, assembling joins the chapters, masters the loudness, and packages the audiobook.'
          }
          action={
            <Link href={`/projects/${bookId}/generation`}>
              <Button variant="primary">Go to generation</Button>
            </Link>
          }
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {projectState.generation_status === 'STALE' ? (
        <Notice tone="warning" title="This audiobook is out of date">
          The book or its story data changed after this version was assembled. It is still complete
          and playable — reassembling produces a <strong>new</strong> version and leaves this one
          exactly as it is.
        </Notice>
      ) : null}

      {audiobook && !isCurrent ? (
        <Notice tone="warning" title={`You are viewing version ${audiobook.version}, which has been superseded`}>
          A newer version of this audiobook exists. This one remains playable and downloadable, and
          is byte-identical to when it was produced.{' '}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => setSelectedId(null)}
          >
            Show the current version
          </button>
          .
        </Notice>
      ) : null}

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap gap-5 p-5">
          {book ? <CoverArt bookId={book.id} title={book.title} size="lg" /> : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg leading-tight font-semibold tracking-tight break-words text-[var(--text-primary)]">
                  {audiobook?.metadata.title ?? book?.title ?? 'Audiobook'}
                </h2>
                <p className="mt-1 text-[13px] text-[var(--text-muted)]">
                  {audiobook?.metadata.author ?? book?.author ?? 'Unknown author'}
                </p>
              </div>
              <StatusBadge
                label={status.label}
                tone={status.tone}
                active={status.active}
                description={status.description}
                size="sm"
              />
            </div>

            {audiobook ? (
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Duration" value={formatDuration(audiobook.duration_ms) ?? '—'} />
                <Stat label="Chapters" value={formatCount(audiobook.chapter_manifest.length)} />
                <Stat label="Version" value={`v${audiobook.version}`} />
                <Stat label="Size" value={formatBytes(audiobook.size_bytes) ?? '—'} />
                <Stat
                  label="Narrator"
                  value={audiobook.metadata.narrator_credit ?? 'Not credited'}
                />
                <Stat label="Format" value={audiobook.container_format} />
                <Stat
                  label="Language"
                  value={formatLanguage(audiobook.metadata.language ?? book?.language)}
                />
                <Stat label="Produced" value={formatAbsoluteTime(audiobook.created_at)} />
              </dl>
            ) : null}

            {audiobook?.metadata.ai_narration_disclosed ? (
              <p className="mt-4 text-[12px] text-[var(--text-muted)]">
                This audiobook is marked as AI-narrated in its own metadata, so players and
                distributors can surface that to listeners.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] bg-[var(--panel-sunken)] px-5 py-4">
          {audiobook ? (
            <DownloadButton
              accessUrlPath={`/api/v1/books/${bookId}/audiobooks/${audiobook.id}/access-urls`}
              disabled={!ready}
              disabledReason={
                !ready
                  ? `This version is ${humanizeEnum(audiobook.status).toLowerCase()}. It can be downloaded once it is ready.`
                  : undefined
              }
              label={`Download ${audiobook.container_format}`}
            />
          ) : null}
          {audiobook && audiobook.available_formats.length > 1 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              Also produced as {audiobook.available_formats.filter((f) => f !== audiobook.container_format).join(', ')}.
            </p>
          ) : null}
        </div>
      </Panel>

      {audiobook && ready ? (
        <Panel className="overflow-hidden">
          <PanelHeader as="h2" title="Listen" />
          <PanelBody>
            <AudiobookPlayer bookId={bookId} audiobook={audiobook} />
          </PanelBody>
        </Panel>
      ) : audiobook ? (
        <Panel>
          <EmptyState
            title="Not ready to play yet"
            description={`This version is ${humanizeEnum(audiobook.status).toLowerCase()}. Playback becomes available once assembly has finished producing the file.`}
            className="py-8"
          />
        </Panel>
      ) : null}

      {audiobook?.quality ? (
        <Panel className="overflow-hidden">
          <PanelHeader
            as="h2"
            title="Quality"
            description="What the studio measured while producing this version. Blank figures mean the measurement was not taken, not that it was perfect."
          />
          <PanelBody>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Stat
                label="Flagged passages"
                value={
                  audiobook.quality.chunks_flagged !== null
                    ? formatCount(audiobook.quality.chunks_flagged)
                    : 'Not measured'
                }
              />
              <Stat
                label="Transcription check coverage"
                value={
                  audiobook.quality.asr_coverage !== null
                    ? `${Math.round(audiobook.quality.asr_coverage * 100)}% of passages`
                    : 'Not measured'
                }
              />
              <Stat
                label="Word error rate"
                value={
                  audiobook.quality.book_wer !== null
                    ? `${(audiobook.quality.book_wer * 100).toFixed(2)}%`
                    : 'Not measured'
                }
              />
            </dl>
          </PanelBody>
        </Panel>
      ) : null}

      {(versions.data?.length ?? 0) > 1 ? (
        <Panel className="overflow-hidden">
          <PanelHeader
            as="h2"
            title="Version history"
            description="Every render is kept. Producing a new version never alters an old one."
          />
          <ul className="divide-y divide-[var(--border-subtle)]">
            {(versions.data ?? [])
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((entry) => (
                <li
                  key={entry.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 px-5 py-3.5',
                    entry.id === activeId && 'bg-[var(--accent-soft)]/40',
                  )}
                >
                  <span className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">
                    v{entry.version}
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-muted)]">
                    {formatAbsoluteTime(entry.created_at)} ·{' '}
                    {formatDuration(entry.duration_ms) ?? 'duration not measured'} ·{' '}
                    {entry.container_format}
                    {entry.is_preview_build ? ' · preview build' : ''}
                  </span>
                  <StatusBadge
                    label={entry.is_current ? 'Current' : 'Superseded'}
                    tone={entry.is_current ? 'success' : 'neutral'}
                    description={
                      entry.is_current
                        ? 'The version this project currently points at.'
                        : 'Replaced by a newer version. Still playable and downloadable, and unchanged.'
                    }
                    size="sm"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedId(entry.id)}
                    disabled={entry.id === activeId}
                    disabledReason={entry.id === activeId ? 'Already shown above.' : undefined}
                  >
                    Open
                  </Button>
                </li>
              ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium break-words text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}
