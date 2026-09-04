'use client';

import { useEffect, useMemo, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useChapters, useCharacters, useScriptChunks, useStartStage } from '@/lib/query/hooks';
import { useCursorPagination } from '@/lib/hooks/useCursorPagination';
import { newIdempotencyKey } from '@/lib/api/client';
import { ReviewItem } from './ReviewItem';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Pagination } from '@/components/ui/Pagination';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { formatCount } from '@/lib/format';

/**
 * The review workspace (Phase 9 rules 51–57, 172, 173).
 *
 * **There is no `/review-items` endpoint.** `api-specification.md` §15.18
 * reserves the concept without specifying it (OQ-3), and Phase 8 deliberately
 * did not invent an entity for it. The review surface the contract *does*
 * provide is flagged script chunks — `GET .../audio-script-chunks?
 * has_review_flags=true` — and that is what this screen is built on.
 *
 * Two consequences the UI states rather than papers over:
 *
 *  - **No severity.** `review_flags[]` is a flat, closed vocabulary with no
 *    severity field, so nothing here is labelled Critical/High/Medium/Low.
 *    Rule 172 permits prioritisation only where the backend supplies severity.
 *  - **No approve/reject state.** There is no `ReviewItem` with a lifecycle, so
 *    there are no Approved/Rejected badges (rule 55 — do not invent unsupported
 *    actions). What the API *does* allow is clearing a chunk's flags, which is
 *    what "mark as resolved" here does, and it says so plainly.
 *
 * The gate is advisory: nothing blocks generation on unreviewed flags, and this
 * screen never claims otherwise.
 */
const PAGE_SIZE = 10;

/** The schema caps `chunk_ids` at 500 per scoped regeneration. */
const MAX_BULK_REGENERATE = 500;

export function ReviewTab() {
  const { bookId, book, progress } = useProject();
  const { toast } = useToast();
  const pagination = useCursorPagination();
  const [chapterId, setChapterId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const chapters = useChapters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const characters = useCharacters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const regenerate = useStartStage(bookId, 'tts');

  const chunks = useScriptChunks(bookId, {
    hasReviewFlags: true,
    chapterId: chapterId || undefined,
    cursor: pagination.cursor,
    limit: PAGE_SIZE,
  });

  useEffect(() => {
    pagination.reset();
    setSelected(new Set());
  }, [chapterId, pagination.reset]);

  const characterNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const character of characters.data ?? []) map.set(character.id, character.display_name);
    return map;
  }, [characters.data]);

  const chapterTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const chapter of chapters.data ?? []) {
      map.set(chapter.id, chapter.title ?? `Chapter ${chapter.order_index + 1}`);
    }
    return map;
  }, [chapters.data]);

  const rows = chunks.data?.data ?? [];
  const flaggedTotal = progress?.needs_review_count ?? null;

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runRegeneration = async () => {
    const ids = [...selected].slice(0, MAX_BULK_REGENERATE);
    try {
      await regenerate.mutateAsync({
        body: { scope: 'CHUNKS', chunk_ids: ids, force: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast({
        message: `Queued ${formatCount(ids.length)} passage${ids.length === 1 ? '' : 's'} for regeneration.`,
        tone: 'success',
      });
      setSelected(new Set());
      setConfirmRegenerate(false);
    } catch {
      setConfirmRegenerate(false);
    }
  };

  if (!book?.current_audio_script_id && !chunks.isPending && rows.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="Nothing to review yet"
          description="Passages are flagged while the performance script is written — where the speaker was uncertain, where a fallback was used, or where a voice could not do what the script asked. They appear here once the director stage has run."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <Notice tone="info" title="Reviewing is optional, and it improves the result">
        Flagged passages do not block generation — the studio will render them as they stand. Each
        one is a place where the director was unsure, and correcting it is what makes the difference
        between a passable narration and a good one.
      </Notice>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Flagged passages"
          description={
            flaggedTotal !== null
              ? `${formatCount(flaggedTotal)} passage${flaggedTotal === 1 ? '' : 's'} flagged across the book.`
              : undefined
          }
          actions={
            selected.size > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[var(--text-muted)]">
                  {formatCount(selected.size)} selected
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <Button size="sm" variant="primary" onClick={() => setConfirmRegenerate(true)}>
                  Regenerate selected
                </Button>
              </div>
            ) : null
          }
        />

        <div className="border-b border-[var(--border-subtle)] px-5 py-3">
          <label htmlFor="review-chapter" className="sr-only">
            Filter by chapter
          </label>
          <Select
            id="review-chapter"
            value={chapterId}
            onChange={(event) => setChapterId(event.target.value)}
            className="max-w-sm"
          >
            <option value="">Every chapter</option>
            {(chapters.data ?? []).map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapter.title ?? `Chapter ${chapter.order_index + 1}`}
              </option>
            ))}
          </Select>
        </div>

        {regenerate.isError ? (
          <PanelBody>
            <ErrorState error={regenerate.error} compact />
          </PanelBody>
        ) : null}

        {chunks.isPending ? (
          <PanelBody>
            <SkeletonText lines={8} />
          </PanelBody>
        ) : chunks.isError ? (
          <PanelBody>
            <ErrorState error={chunks.error} onRetry={() => void chunks.refetch()} compact />
          </PanelBody>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No flagged passages"
            description={
              chapterId
                ? 'This chapter has nothing flagged. Choose another chapter, or clear the filter.'
                : 'Nothing in this book is waiting on a review decision.'
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {rows.map((chunk) => (
              <ReviewItem
                key={chunk.id}
                bookId={bookId}
                chunk={chunk}
                chapterTitle={chapterTitles.get(chunk.chapter_id) ?? 'Unknown chapter'}
                characterNames={characterNames}
                selected={selected.has(chunk.id)}
                onToggleSelected={() => toggleSelected(chunk.id)}
              />
            ))}
          </ul>
        )}

        {rows.length > 0 ? (
          <Pagination
            label="Review pages"
            shownCount={rows.length}
            total={chunks.data?.page.total ?? null}
            hasPrevious={pagination.hasPrevious}
            hasNext={Boolean(chunks.data?.page.has_more)}
            loading={chunks.isFetching}
            onPrevious={pagination.previous}
            onNext={() => pagination.next(chunks.data?.page.next_cursor ?? null)}
          />
        ) : null}
      </Panel>

      <ConfirmDialog
        open={confirmRegenerate}
        onOpenChange={setConfirmRegenerate}
        title={`Regenerate ${formatCount(Math.min(selected.size, MAX_BULK_REGENERATE))} passages?`}
        consequence={
          <>
            This re-renders only the selected passages, using the current script and voices. Each
            produces a <strong>new version</strong> — the existing audio is superseded, not
            overwritten, and stays downloadable. The rest of the book is untouched.
            {selected.size > MAX_BULK_REGENERATE ? (
              <>
                {' '}
                Only the first {formatCount(MAX_BULK_REGENERATE)} of your{' '}
                {formatCount(selected.size)} selected passages are included — that is the limit the
                studio accepts in one request.
              </>
            ) : null}
          </>
        }
        confirmLabel="Regenerate"
        busy={regenerate.isPending}
        onConfirm={() => void runRegeneration()}
      />
    </div>
  );
}
