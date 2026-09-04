'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useAudiobookProject, useChapterAudio, useChapters } from '@/lib/query/hooks';
import { useVirtualRows } from '@/lib/hooks/useVirtualRows';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { TextInput } from '@/components/ui/Field';
import { formatCount, formatDuration } from '@/lib/format';
import { chapterAudioDisplay } from '@/lib/chapter-status';
import type { Chapter } from '@/lib/api/types';

const ROW_HEIGHT = 60;

/**
 * The chapter production list (Phase 9 rules 21, 22, 89, 139).
 *
 * Joins `GET .../chapters` with `GET .../chapter-audio` — both bounded by one
 * project, both fully enumerated once, then windowed for rendering. A
 * 400-chapter book puts ~30 rows in the DOM, which is what keeps rule 139's
 * "no browser freeze" true rather than aspirational.
 */
export function ChaptersTab() {
  const { bookId, book } = useProject();
  const chapters = useChapters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const chapterAudio = useChapterAudio(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const audiobook = useAudiobookProject(bookId);
  const [search, setSearch] = useState('');

  const audioByChapter = useMemo(() => {
    const map = new Map<string, { status: string; durationMs: number | null; id: string }>();
    for (const entry of chapterAudio.data ?? []) {
      if (!entry.is_current) continue;
      map.set(entry.chapter_id, {
        status: entry.status,
        durationMs: entry.technical.duration_ms,
        id: entry.id,
      });
    }
    // `GET .../audiobook` also carries per-chapter status; it is the fallback
    // when the chapter-audio collection has not loaded.
    for (const entry of audiobook.data?.chapters ?? []) {
      if (!map.has(entry.chapter_id) && entry.chapter_audio_id) {
        map.set(entry.chapter_id, {
          status: entry.status,
          durationMs: entry.duration_ms,
          id: entry.chapter_audio_id,
        });
      }
    }
    return map;
  }, [chapterAudio.data, audiobook.data]);

  const rows = useMemo(() => {
    const all = chapters.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((chapter) =>
      (chapter.title ?? `chapter ${chapter.order_index + 1}`).toLowerCase().includes(needle),
    );
  }, [chapters.data, search]);

  const virtual = useVirtualRows<Chapter>({ items: rows, rowHeight: ROW_HEIGHT });

  const totalDuration = useMemo(
    () => [...audioByChapter.values()].reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
    [audioByChapter],
  );

  if (!book?.current_book_version_id) {
    return (
      <Panel>
        <EmptyState
          title="No chapters yet"
          description="Chapters appear once the studio has read the source book and identified its structure."
        />
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Chapters"
        description={
          chapters.data
            ? `${formatCount(chapters.data.length)} chapters${totalDuration > 0 ? ` · ${formatDuration(totalDuration)} of audio so far` : ''}`
            : undefined
        }
      />

      <div className="border-b border-[var(--border-subtle)] px-5 py-3">
        <label htmlFor="chapter-search" className="sr-only">
          Filter chapters
        </label>
        <TextInput
          id="chapter-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter chapters by title…"
          className="max-w-sm"
        />
      </div>

      {chapters.isPending ? (
        <PanelBody>
          <SkeletonText lines={8} />
        </PanelBody>
      ) : chapters.isError ? (
        <PanelBody>
          <ErrorState error={chapters.error} onRetry={() => void chapters.refetch()} compact />
        </PanelBody>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No chapters match that filter"
          description="Try a shorter search term."
        />
      ) : (
        <div
          ref={virtual.containerRef}
          onScroll={virtual.onScroll}
          className="max-h-[40rem] overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={`${formatCount(rows.length)} chapters`}
        >
          <div
            style={virtual.totalHeight ? { height: virtual.totalHeight, position: 'relative' } : undefined}
          >
            <ul
              style={
                virtual.windowed
                  ? {
                      transform: `translateY(${virtual.offsetY}px)`,
                      position: 'absolute',
                      inset: '0 0 auto 0',
                    }
                  : undefined
              }
              className="divide-y divide-[var(--border-subtle)]"
            >
              {virtual.visibleItems.map((chapter) => {
                const audio = audioByChapter.get(chapter.id);
                const display = chapterAudioDisplay(audio?.status);
                return (
                  <li key={chapter.id} style={{ height: ROW_HEIGHT }}>
                    <Link
                      href={`/projects/${bookId}/chapters/${chapter.id}`}
                      className="flex h-full items-center gap-4 px-5 transition-colors hover:bg-[var(--panel-raised)]"
                    >
                      <span className="w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
                        {chapter.order_index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {chapter.title ?? `Chapter ${chapter.order_index + 1}`}
                      </span>
                      <span className="hidden w-20 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--text-muted)] sm:block">
                        {formatDuration(audio?.durationMs ?? null) ?? '—'}
                      </span>
                      <StatusBadge
                        label={display.label}
                        tone={display.tone}
                        description={display.description}
                        size="sm"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}
