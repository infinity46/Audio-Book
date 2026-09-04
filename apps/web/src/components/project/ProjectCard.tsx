'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CoverArt } from './CoverArt';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, TextInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format';
import { bookStatusDisplay, nextActionForBook } from '@/lib/status';
import { cn } from '@/lib/cn';
import { usePurgeBook, useRestoreBook } from '@/lib/query/hooks';
import type { Book, BookProgress } from '@/lib/api/types';

/**
 * A project in a list (Phase 9 rule 8).
 *
 * Shows what the collection endpoint actually returns, plus a live progress bar
 * **only** when the caller supplies a progress reading. `GET /books` does not
 * support `?include=stages` (only `GET /books/{id}` does), so a grid of cards
 * cannot show per-project progress without one request per card — which would
 * spend a tenant's `read` budget on decoration. The dashboard therefore fetches
 * progress for the handful of *active* projects and passes it here; everywhere
 * else the card shows status and the next step, and invents nothing.
 * Recorded as GAP-2.
 *
 * A deleted book (Phase 10: `POST .../restoration` and `POST .../purge` are
 * now real) gets two actions instead of the usual "open project" affordance —
 * see the `deleted_at` branch below.
 */
export function ProjectCard({
  book,
  progress,
  className,
}: {
  book: Book;
  progress?: BookProgress | null;
  className?: string;
}) {
  const status = bookStatusDisplay(book.status);
  const action = nextActionForBook({
    status: book.status,
    needsReview: book.needs_review,
    hasSourceFile: Boolean(book.current_book_version_id),
    audiobookReady: book.status === 'COMPLETED',
  });

  return (
    <article
      className={cn(
        'group relative flex flex-col rounded-[var(--radius-panel)] border border-[var(--border-subtle)]',
        'bg-[var(--panel)] p-4 shadow-[var(--shadow-panel)] transition-shadow hover:shadow-[var(--shadow-raised)]',
        book.deleted_at && 'opacity-60',
        className,
      )}
    >
      <div className="flex gap-3.5">
        <CoverArt bookId={book.id} title={book.title} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] leading-snug font-semibold tracking-tight text-[var(--text-primary)]">
            {/*
              The whole card is reachable through this one link: a card-wide
              overlay link keeps a single tab stop and one accessible name,
              instead of scattering three links over the same rectangle. A
              deleted book has nothing to open, so it is not a link.
            */}
            {book.deleted_at ? (
              <span className="line-clamp-2 break-words">{book.title}</span>
            ) : (
              <Link href={`/projects/${book.id}`} className="before:absolute before:inset-0">
                {/* Long titles wrap rather than truncate — rule 104. */}
                <span className="line-clamp-2 break-words">{book.title}</span>
              </Link>
            )}
          </h3>
          <p className="mt-1 truncate text-[13px] text-[var(--text-muted)]">
            {book.author ?? 'Unknown author'}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <StatusBadge
              label={status.label}
              tone={status.tone}
              active={status.active}
              description={status.description}
              size="sm"
            />
            {book.needs_review && book.status !== 'NEEDS_REVIEW' ? (
              <StatusBadge label="Review required" tone="warning" size="sm" />
            ) : null}
            {book.deleted_at ? <StatusBadge label="Deleted" tone="neutral" size="sm" /> : null}
          </div>
        </div>
      </div>

      {progress ? (
        <div className="mt-4">
          <ProgressBar
            value={progress.overall_progress}
            label="Overall progress"
            tone={status.tone === 'danger' ? 'danger' : 'progress'}
          />
        </div>
      ) : null}

      {book.deleted_at ? (
        <DeletedBookActions book={book} />
      ) : (
        <div className="mt-4 flex items-end justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
          <p className="text-[12px] text-[var(--text-muted)]">
            Updated{' '}
            <time dateTime={book.updated_at} title={formatAbsoluteTime(book.updated_at)}>
              {formatRelativeTime(book.updated_at)}
            </time>
          </p>
          {/* Relative to the card link, so it reads as the card's primary action. */}
          <span className="relative z-10 text-[13px] font-semibold text-[var(--accent-text)] group-hover:underline">
            {action.label} →
          </span>
        </div>
      )}
    </article>
  );
}

/**
 * `TENANT_OWNER`-only on the API side (§16.6.2/§16.6.3) — a non-owner sees
 * these controls (there is no `roles`-aware hiding here, matching how the
 * rest of the studio lets the server be the one source of truth on
 * authorization, rule 74) and gets the API's own `403` in a toast rather
 * than a control that silently does nothing.
 */
function DeletedBookActions({ book }: { book: Book }) {
  const restore = useRestoreBook();
  const purge = usePurgeBook();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const { toast } = useToast();

  const handleRestore = () => {
    restore.mutate(book.id, {
      onSuccess: () => toast({ message: `${book.title} restored.`, tone: 'success' }),
      onError: () => toast({ message: 'Could not restore this project.', tone: 'warning' }),
    });
  };

  const handlePurge = () => {
    purge.mutate(
      { bookId: book.id, confirmBookId: book.id },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          toast({ message: `${book.title} permanently deleted.`, tone: 'success' });
        },
        onError: () => toast({ message: 'Could not delete this project.', tone: 'warning' }),
      },
    );
  };

  return (
    <div className="relative z-10 mt-4 flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
      <Button size="sm" variant="secondary" loading={restore.isPending} onClick={handleRestore}>
        Restore
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          setConfirmText('');
          setConfirmOpen(true);
        }}
      >
        Delete permanently
      </Button>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => !purge.isPending && setConfirmOpen(open)}
        title="Delete this project permanently?"
        busy={purge.isPending}
        description={
          <>
            This cannot be undone. Every chapter, character, script, and audio file for{' '}
            <strong>{book.title}</strong> will be permanently removed. Type the project title to
            confirm.
          </>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={purge.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={purge.isPending}
              disabled={confirmText.trim() !== book.title}
              onClick={handlePurge}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <Field label="Project title">
          {({ id }) => (
            <TextInput
              id={id}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={book.title}
              autoComplete="off"
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

export function ProjectCardSkeleton() {
  return (
    <div className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--panel)] p-4">
      <div className="flex gap-3.5">
        <div className="skeleton h-16 w-11 shrink-0 rounded-[0.35rem]" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-3 w-1/2" />
          <div className="skeleton h-5 w-24 rounded-full" />
        </div>
      </div>
      <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
        <div className="skeleton h-3 w-32" />
      </div>
    </div>
  );
}
