'use client';

import { useMemo, useState } from 'react';
import { useProject } from './ProjectContext';
import { useBookFiles, useCapabilities } from '@/lib/query/hooks';
import { FileDropZone } from './FileDropZone';
import { uploadSourceFile, validateSourceFile, type UploadPhase } from '@/lib/upload';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { humanizeEnum } from '@/lib/status';
import { ACCEPTED_MIME_TYPES } from '@/lib/api/types';
import { ApiError } from '@/lib/api/errors';

/**
 * Source files, and the upload path for a project that has none yet.
 *
 * The same three-call flow as project creation, reused rather than duplicated.
 * A duplicate content hash is a `409` the user can act on: the API accepts
 * `allow_duplicate: true`, so the refusal is turned into an explicit choice
 * rather than a dead end.
 */
export function SourceFilePanel() {
  const { bookId, refetch } = useProject();
  const files = useBookFiles(bookId);
  const capabilities = useCapabilities();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);

  const limits = useMemo(() => {
    const accepted = capabilities.data?.upload.accepted_mime_types ?? [...ACCEPTED_MIME_TYPES];
    const maxUpload = capabilities.data?.limits.max_upload_bytes;
    const values = maxUpload ? Object.values(maxUpload).filter((n) => typeof n === 'number') : [];
    return { acceptedMimeTypes: accepted, maxBytes: values.length > 0 ? Math.max(...values) : null };
  }, [capabilities.data]);

  const existing = files.data?.data ?? [];
  const busy = phase !== null;

  const isDuplicateConflict =
    error instanceof ApiError && error.code === 'DUPLICATE_CONTENT_HASH';

  const startUpload = async () => {
    if (!file || busy) return;
    setError(null);
    try {
      await uploadSourceFile({ bookId, file, limits, onPhase: setPhase, allowDuplicate });
      setFile(null);
      setAllowDuplicate(false);
      refetch();
      void files.refetch();
    } catch (uploadError) {
      setError(uploadError);
    } finally {
      setPhase(null);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Source file"
        description="The book this audiobook is produced from."
      />

      {files.isPending ? (
        <PanelBody>
          <SkeletonText lines={2} />
        </PanelBody>
      ) : files.isError ? (
        <PanelBody>
          <ErrorState error={files.error} onRetry={() => void files.refetch()} compact />
        </PanelBody>
      ) : existing.length > 0 ? (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {existing.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {entry.original_file_name}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                  {entry.source_kind} · {formatBytes(entry.size_bytes)} · added{' '}
                  {formatRelativeTime(entry.created_at)}
                </p>
              </div>
              <StatusBadge
                label={humanizeEnum(entry.status)}
                tone={entry.status === 'ADMITTED' ? 'success' : 'neutral'}
                size="sm"
              />
            </li>
          ))}
        </ul>
      ) : (
        <PanelBody className="space-y-4">
          <EmptyState
            title="No source file yet"
            description="Attach a PDF or EPUB. The studio verifies it, extracts the text, and finds the chapter structure."
            className="py-6"
          />
          <FileDropZone
            onFileSelected={(candidate) => {
              setFileError(null);
              setError(null);
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
            }}
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            maxBytes={limits.maxBytes}
            file={file}
            disabled={busy}
            error={fileError}
          />

          {error ? (
            <ErrorState
              error={error}
              compact
              secondaryAction={
                isDuplicateConflict ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setAllowDuplicate(true);
                      setError(null);
                    }}
                  >
                    Upload it anyway
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {allowDuplicate ? (
            <Notice tone="info" title="Duplicate will be allowed">
              This workspace already holds a file with identical content. Uploading it again is
              permitted; it creates a separate source file.
            </Notice>
          ) : null}

          {phase?.kind === 'uploading' ? (
            <ProgressBar value={phase.fraction} label="Uploading to storage" />
          ) : phase ? (
            <p className="text-[13px] text-[var(--text-muted)]">
              {phase.kind === 'finalizing'
                ? 'Upload complete. The server is verifying the file…'
                : 'Preparing the file…'}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => void startUpload()}
              loading={busy}
              disabled={!file}
              disabledReason={!file ? 'Choose a PDF or EPUB first.' : undefined}
            >
              Upload source
            </Button>
          </div>
        </PanelBody>
      )}
    </Panel>
  );
}
