'use client';

import Link from 'next/link';
import { useVirtualRows } from '@/lib/hooks/useVirtualRows';
import { formatCount } from '@/lib/format';
import { humanizeEnum } from '@/lib/status';
import type { Chapter } from '@/lib/api/types';

const ROW_HEIGHT = 56;

/**
 * The chapter structure list (Phase 9 rules 21, 22, 89, 139).
 *
 * Windowed above 60 rows, so a 400-chapter book renders ~30 nodes rather than
 * 400. Below that threshold it renders plainly, which keeps browser
 * find-in-page working for the common case.
 *
 * Chapter titles come from the book and are therefore untrusted content
 * (rules 123–125). They are rendered as React text nodes — escaped by
 * construction — and never as markup.
 */
export function ChapterStructureList({
  chapters,
  bookId,
}: {
  chapters: Chapter[];
  bookId: string;
}) {
  const { containerRef, onScroll, totalHeight, offsetY, visibleItems, startIndex, windowed } =
    useVirtualRows({ items: chapters, rowHeight: ROW_HEIGHT });

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="max-h-[32rem] overflow-y-auto"
      // A scroll container must be keyboard-reachable, or its content is
      // unreachable without a pointer.
      tabIndex={0}
      role="region"
      aria-label={`${formatCount(chapters.length)} chapters`}
    >
      <div style={totalHeight ? { height: totalHeight, position: 'relative' } : undefined}>
        <ul
          style={
            windowed
              ? { transform: `translateY(${offsetY}px)`, position: 'absolute', inset: '0 0 auto 0' }
              : undefined
          }
          className="divide-y divide-[var(--border-subtle)]"
        >
          {visibleItems.map((chapter, index) => (
            <li key={chapter.id} style={{ height: ROW_HEIGHT }}>
              <Link
                href={`/projects/${bookId}/chapters/${chapter.id}`}
                className="flex h-full items-center gap-4 px-5 transition-colors hover:bg-[var(--panel-raised)]"
              >
                <span className="w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
                  {startIndex + index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                  {chapter.title ?? `Chapter ${chapter.order_index + 1}`}
                </span>
                <span className="hidden shrink-0 text-[12px] text-[var(--text-muted)] sm:inline">
                  {humanizeEnum(chapter.matter_type)}
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
                  {formatCount(chapter.char_count)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
