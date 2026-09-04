'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useCapabilities, useCreateBook } from '@/lib/query/hooks';
import { ApiError } from '@/lib/api/errors';
import { uploadSourceFile, validateSourceFile, type UploadPhase } from '@/lib/upload';
import { FileDropZone } from './FileDropZone';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextArea, TextInput } from '@/components/ui/Field';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ErrorState, Notice } from '@/components/ui/States';
import { useUnsavedChangesWarning } from '@/lib/hooks/useUnsavedChangesWarning';
import { ACCEPTED_MIME_TYPES } from '@/lib/api/types';

/**
 * Create a project and attach its source (Phase 9 rules 11–17, 39, 110).
 *
 * The whole thing is one page rather than a wizard in a modal (rule 106), and
 * the two progress notions are kept visually and textually separate (rule 15):
 * **Uploading** is bytes to storage and reaches 100% quickly; **Reading the
 * book** is server-side work that starts afterwards and is watched in the
 * project workspace. Nothing here animates a percentage the server did not
 * report (rule 17).
 */

type Phase = { kind: 'form' } | { kind: 'creating' } | UploadPhase;

const LANGUAGES = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'de-DE', label: 'German' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'nl-NL', label: 'Dutch' },
  { value: 'ja-JP', label: 'Japanese' },
];

export function CreateProjectView() {
  const router = useRouter();
  const capabilities = useCapabilities();
  const createBook = useCreateBook();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [language, setLanguage] = useState('en-US');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const busy = phase.kind !== 'form';
  const dirty = Boolean(title || author || description || file);

  // Rule 110 — a half-filled project form is worth a confirmation.
  useUnsavedChangesWarning(dirty && !busy);

  const limits = useMemo(() => {
    const accepted = capabilities.data?.upload.accepted_mime_types ?? [...ACCEPTED_MIME_TYPES];
    const maxUpload = capabilities.data?.limits.max_upload_bytes;
    const maxBytes = maxUpload
      ? Math.max(...Object.values(maxUpload).filter((n) => typeof n === 'number'))
      : null;
    return { acceptedMimeTypes: accepted, maxBytes: Number.isFinite(maxBytes) ? maxBytes : null };
  }, [capabilities.data]);

  const handleFile = useCallback(
    (candidate: File | null) => {
      setFileError(null);
      if (!candidate) {
        setFile(null);
        return;
      }
      const result = validateSourceFile(candidate, limits);
      if (!result.ok) {
        setFile(null);
        setFileError(result.reason ?? 'That file cannot be used.');
        return;
      }
      setFile(candidate);
    },
    [limits],
  );

  const titleError =
    submitError instanceof ApiError ? (submitError.fieldIssues().title ?? null) : null;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return; // Rule 39: no duplicate submission while a request is in flight.
    setSubmitError(null);

    let createdBookId: string | undefined;
    try {
      setPhase({ kind: 'creating' });
      const book = await createBook.mutateAsync({
        title: title.trim(),
        author: author.trim() || undefined,
        language,
        description: description.trim() || undefined,
      });
      createdBookId = book.id;

      if (file) {
        await uploadSourceFile({ bookId: book.id, file, limits, onPhase: setPhase });
      }

      router.push(`/projects/${book.id}`);
    } catch (error) {
      setPhase({ kind: 'form' });
      // The project row survives a failed upload, so the user is pointed at it
      // rather than left with an invisible orphan they would create again.
      setSubmitError(createdBookId ? new PartialCreateError(error, createdBookId) : error);
    }
  };

  const partialBookId = submitError instanceof PartialCreateError ? submitError.bookId : null;
  const displayError = submitError instanceof PartialCreateError ? submitError.cause : submitError;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="mb-2">
          <Link href="/projects" className="text-[13px] text-[var(--text-muted)] hover:underline">
            ← Projects
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          New audiobook project
        </h1>
        <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
          Give the project a title and attach the source book. Everything else — chapters,
          characters, voices — is discovered from the text.
        </p>
      </header>

      {submitError ? (
        <ErrorState
          error={displayError}
          secondaryAction={
            partialBookId ? (
              <Link href={`/projects/${partialBookId}`}>
                <Button size="sm">Open the created project</Button>
              </Link>
            ) : undefined
          }
        />
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="space-y-5">
        <Panel>
          <PanelHeader title="Project details" />
          <PanelBody className="space-y-4">
            <Field label="Title" required error={titleError}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={500}
                  disabled={busy}
                  placeholder="The Long Voyage"
                />
              )}
            </Field>

            <Field label="Author">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={author}
                  onChange={(event) => setAuthor(event.target.value)}
                  maxLength={500}
                  disabled={busy}
                  placeholder="A. Writer"
                />
              )}
            </Field>

            <Field
              label="Language"
              required
              hint="The language of the source text. This cannot be changed once the book has been read."
            >
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  disabled={busy}
                >
                  {LANGUAGES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Description">
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={4000}
                  disabled={busy}
                  rows={3}
                />
              )}
            </Field>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Source book"
            description="PDF or EPUB. The file goes straight to secure storage — it is not uploaded through this page."
          />
          <PanelBody className="space-y-4">
            <FileDropZone
              onFileSelected={handleFile}
              accept=".pdf,.epub,application/pdf,application/epub+zip"
              maxBytes={limits.maxBytes}
              file={file}
              disabled={busy}
              error={fileError}
            />

            {phase.kind === 'uploading' ? (
              <ProgressBar
                value={phase.fraction}
                label="Uploading to storage"
                tone="progress"
              />
            ) : null}
            {phase.kind === 'hashing' || phase.kind === 'requesting' ? (
              <p className="text-[13px] text-[var(--text-muted)]">Preparing the file…</p>
            ) : null}
            {phase.kind === 'finalizing' ? (
              <p className="text-[13px] text-[var(--text-muted)]">
                Upload complete. The server is verifying the file…
              </p>
            ) : null}

            <Notice tone="info" title="Uploading is not the same as processing">
              Once the file reaches storage, the studio verifies it and starts reading the book.
              That takes considerably longer than the upload, and you can leave this page — progress
              is kept on the server.
            </Notice>
          </PanelBody>
        </Panel>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/projects">
            <Button variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </Link>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            disabled={!title.trim()}
            disabledReason={!title.trim() ? 'Give the project a title first.' : undefined}
          >
            {file ? 'Create and upload' : 'Create project'}
          </Button>
        </div>
        {!file ? (
          <p className="text-right text-[12px] text-[var(--text-muted)]">
            You can attach the source file later from the project’s Book tab.
          </p>
        ) : null}
      </form>
    </div>
  );
}

/**
 * Carries the id of a project that *was* created before a later step failed, so
 * the recovery affordance can point at it instead of stranding the row.
 */
class PartialCreateError extends Error {
  readonly bookId: string;
  override readonly cause: unknown;
  constructor(cause: unknown, bookId: string) {
    super('The project was created, but the source file could not be attached.');
    this.name = 'PartialCreateError';
    this.cause = cause;
    this.bookId = bookId;
  }
}
