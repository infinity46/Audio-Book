'use client';

import { useState } from 'react';
import { useProject } from './ProjectContext';
import { useUpdateBook } from '@/lib/query/hooks';
import { ApiError } from '@/lib/api/errors';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, TextInput } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { formatLanguage } from '@/lib/format';

/**
 * Metadata editing (Phase 9 rules 70, 71, 110).
 *
 * Only the five fields `PATCH /books/{id}` accepts are editable — `title`,
 * `author`, `language`, `description`, `metadata`. `status` is deliberately
 * absent: it is not in the request schema, and sending it is `422
 * unknown_field`. There is no raw-field editor and no way to reach a column the
 * API does not expose.
 *
 * The `ETag` from the last read is sent as `If-Match`, so a second session
 * editing the same field gets `409 RESOURCE_VERSION_CONFLICT` instead of
 * silently clobbering (rule 46).
 */
export function BookMetadataForm({
  editing,
  onDone,
}: {
  editing: boolean;
  onDone: () => void;
}) {
  const { bookId, book, etag } = useProject();
  const { toast } = useToast();
  const update = useUpdateBook(bookId);

  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [description, setDescription] = useState(book?.description ?? '');

  if (!book) return null;

  // `language` cannot change once ingestion has produced canonical text — the
  // API answers `409 INVALID_STATE_TRANSITION`. Showing an editable control
  // that is guaranteed to fail would be a dead control (rule 160).
  const languageLocked = Boolean(book.current_book_version_id);

  if (!editing) {
    return (
      <dl className="grid gap-4 sm:grid-cols-2">
        <ReadRow label="Title" value={book.title} />
        <ReadRow label="Author" value={book.author ?? 'Not set'} />
        <ReadRow label="Language" value={formatLanguage(book.language)} />
        <ReadRow label="Series" value={book.metadata.series ?? 'Not set'} />
        <div className="sm:col-span-2">
          <ReadRow label="Description" value={book.description ?? 'Not set'} />
        </div>
      </dl>
    );
  }

  const fieldIssues = update.error instanceof ApiError ? update.error.fieldIssues() : {};

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await update.mutateAsync({
        body: {
          title: title.trim(),
          author: author.trim() || null,
          description: description.trim() || null,
        },
        etag,
      });
      toast({ message: 'Project details saved.', tone: 'success' });
      onDone();
    } catch {
      // Rendered inline below — a failed save must not be communicated only by
      // a toast that disappears (rule 112).
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
      {update.isError ? (
        <ErrorState
          error={update.error}
          compact
          secondaryAction={
            update.error instanceof ApiError &&
            update.error.code === 'RESOURCE_VERSION_CONFLICT' ? (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload the latest version
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <Field label="Title" required error={fieldIssues.title}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={500}
          />
        )}
      </Field>

      <Field label="Author" error={fieldIssues.author}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            maxLength={500}
          />
        )}
      </Field>

      <Field
        label="Language"
        hint={
          languageLocked
            ? 'The language cannot change once the book has been read — the extracted text depends on it. Create a new project to use a different language.'
            : undefined
        }
      >
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            value={book.language}
            readOnly
            disabled
            title={languageLocked ? 'Locked after ingestion.' : undefined}
          />
        )}
      </Field>

      <Field label="Description" error={fieldIssues.description}>
        {({ id, describedBy, invalid }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4000}
            rows={4}
          />
        )}
      </Field>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[13px] leading-relaxed break-words text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}
