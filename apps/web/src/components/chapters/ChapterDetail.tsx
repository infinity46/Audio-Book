'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useAudioChunks, useChapterAudio, useChapters, useScriptChunks } from '@/lib/query/hooks';
import { useSignedAudio } from '@/lib/hooks/useSignedAudio';
import { AudioPlayer } from '@/components/audio/AudioPlayer';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorPanel, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatCount, formatDuration } from '@/lib/format';
import { chapterAudioDisplay } from '@/lib/chapter-status';
import { reviewFlagDisplay } from '@/lib/status';

/**
 * A single chapter (Phase 9 rules 23, 59, 62).
 *
 * Loads **only this chapter's** artifact: the signed URL is minted for one
 * `ChapterAudio` row, so selecting a chapter never pulls the whole audiobook
 * (rule 62). Nothing is fetched until play is pressed (rule 91).
 */
export function ChapterDetail({ chapterId }: { chapterId: string }) {
  const { bookId, book } = useProject();
  const chapters = useChapters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const chapterAudio = useChapterAudio(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const flagged = useScriptChunks(bookId, { chapterId, hasReviewFlags: true, limit: 5 });
  const failedAudio = useAudioChunks(bookId, { chapterId, status: 'FAILED,INVALID', limit: 5 });

  const chapter = chapters.data?.find((entry) => entry.id === chapterId) ?? null;
  const audioVersions = useMemo(
    () => (chapterAudio.data ?? []).filter((entry) => entry.chapter_id === chapterId),
    [chapterAudio.data, chapterId],
  );
  const current = audioVersions.find((entry) => entry.is_current) ?? null;
  const superseded = audioVersions.filter((entry) => !entry.is_current);

  const audio = useSignedAudio(
    current ? `/api/v1/books/${bookId}/chapter-audio/${current.id}/access-urls` : null,
  );

  if (chapters.isError) {
    return <ErrorPanel error={chapters.error} onRetry={() => void chapters.refetch()} />;
  }

  const display = chapterAudioDisplay(current?.status);
  const flaggedCount = flagged.data?.data.length ?? 0;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <Link
          href={`/projects/${bookId}/chapters`}
          className="text-[13px] text-[var(--text-muted)] hover:underline"
        >
          ← Chapters
        </Link>
      </nav>

      <Panel className="overflow-hidden">
        <PanelHeader
          as="h2"
          title={chapter?.title ?? (chapters.isPending ? 'Loading…' : 'Chapter')}
          description={
            chapter
              ? `Chapter ${chapter.order_index + 1} · ${formatCount(chapter.char_count)} characters of text`
              : undefined
          }
          actions={
            <StatusBadge
              label={display.label}
              tone={display.tone}
              description={display.description}
              size="sm"
            />
          }
        />
        <PanelBody className="space-y-4">
          {chapterAudio.isPending ? (
            <SkeletonText lines={3} />
          ) : current ? (
            <>
              <AudioPlayer
                audio={audio}
                title={chapter?.title ?? `chapter ${(chapter?.order_index ?? 0) + 1}`}
                durationMsHint={current.technical.duration_ms}
              />
              <dl className="grid gap-4 sm:grid-cols-3">
                <Stat
                  label="Duration"
                  value={formatDuration(current.technical.duration_ms) ?? 'Not measured'}
                />
                <Stat label="Version" value={`v${current.version}`} />
                <Stat
                  label="Passages"
                  value={
                    current.technical.chunk_count !== null
                      ? formatCount(current.technical.chunk_count)
                      : '—'
                  }
                />
                <Stat
                  label="Loudness"
                  value={
                    current.loudness.integrated_lufs !== null
                      ? `${current.loudness.integrated_lufs.toFixed(1)} LUFS`
                      : 'Not measured'
                  }
                />
                <Stat
                  label="True peak"
                  value={
                    current.loudness.true_peak_dbtp !== null
                      ? `${current.loudness.true_peak_dbtp.toFixed(1)} dBTP`
                      : 'Not measured'
                  }
                />
                <Stat label="Format" value={current.technical.format ?? '—'} />
              </dl>

              {current.is_preview_build ? (
                <Notice tone="warning" title="This is a preview build">
                  It was assembled from incomplete audio, so some passages may be missing. It is not
                  the finished chapter.
                </Notice>
              ) : null}
            </>
          ) : (
            <EmptyState
              title="No audio for this chapter yet"
              description="Once audio has been generated for the whole book and assembled, this chapter's audio appears here."
              className="py-8"
            />
          )}
        </PanelBody>
      </Panel>

      {(flaggedCount > 0 || (failedAudio.data?.data.length ?? 0) > 0) ? (
        <Panel className="overflow-hidden">
          <PanelHeader
            as="h2"
            title="Quality notes for this chapter"
            description="What the studio flagged while producing it. These are advisory — nothing is blocked."
          />
          <PanelBody className="space-y-3">
            {flaggedCount > 0 ? (
              <div>
                <p className="text-[13px] text-[var(--text-secondary)]">
                  {formatCount(flaggedCount)}
                  {flagged.data?.page.has_more ? '+' : ''} flagged passage
                  {flaggedCount === 1 ? '' : 's'} in this chapter:
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {[
                    ...new Set(
                      (flagged.data?.data ?? []).flatMap((chunk) => chunk.review_flags),
                    ),
                  ].map((flag) => {
                    const info = reviewFlagDisplay(flag);
                    return (
                      <li key={flag}>
                        <StatusBadge
                          label={info.label}
                          tone="warning"
                          description={info.description}
                          size="sm"
                        />
                      </li>
                    );
                  })}
                </ul>
                <Link
                  href={`/projects/${bookId}/review`}
                  className="mt-3 inline-block text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
                >
                  Review these passages →
                </Link>
              </div>
            ) : null}

            {(failedAudio.data?.data.length ?? 0) > 0 ? (
              <Notice tone="danger" title="Some passages did not render">
                {formatCount(failedAudio.data?.data.length ?? 0)}
                {failedAudio.data?.page.has_more ? '+' : ''} passage
                {(failedAudio.data?.data.length ?? 0) === 1 ? '' : 's'} in this chapter failed or
                failed validation. Regenerating the chapter from the Generation tab produces a new
                version and leaves the existing audio intact.
              </Notice>
            ) : null}
          </PanelBody>
        </Panel>
      ) : null}

      {superseded.length > 0 ? (
        <Panel className="overflow-hidden">
          <PanelHeader
            as="h2"
            title="Earlier versions"
            description="Regeneration never overwrites. Previous renders stay exactly as they were."
          />
          <ul className="divide-y divide-[var(--border-subtle)]">
            {superseded.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-5 py-3">
                <span className="font-mono text-[13px] text-[var(--text-secondary)]">
                  v{entry.version}
                </span>
                <span className="flex-1 text-[12px] text-[var(--text-muted)]">
                  {formatDuration(entry.technical.duration_ms) ?? 'Duration not measured'}
                </span>
                <StatusBadge label="Superseded" tone="neutral" size="sm" />
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
      <dd className="mt-0.5 font-mono text-[13px] tabular-nums text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}
