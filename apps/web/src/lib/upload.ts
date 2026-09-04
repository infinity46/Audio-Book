'use client';

/**
 * Source-file upload (Phase 9 rules 12–15).
 *
 * Three calls, and **the bytes never pass through this application**:
 *
 *   POST .../upload-sessions           → a signed, single-use PUT target
 *   PUT  <signed url>                  → the file, straight to object storage
 *   POST .../upload-sessions/{id}/completion
 *
 * The server then re-downloads, verifies size and SHA-256, sniffs the real
 * format against the declared one, and only then admits the file. So the
 * client-side checks below are a *courtesy* — they fail fast on the obvious
 * cases — and the backend remains authoritative (rule 14).
 *
 * `XMLHttpRequest` rather than `fetch` for the PUT: `fetch` still has no upload
 * progress event in any shipping browser, and rule 15 requires the upload
 * percentage to be real rather than animated.
 */

export interface UploadProgress {
  /** `0`–`1`. This is bytes to storage — **not** processing progress. */
  fraction: number;
  loadedBytes: number;
  totalBytes: number;
}

export class UploadFailure extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'UploadFailure';
    this.status = status;
  }
}

/** SHA-256, hex, as the upload session's `declared_content_hash` requires. */
export async function sha256Hex(file: File): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new UploadFailure(
      'This browser cannot compute the checksum the upload requires. A secure (https) context is needed.',
    );
  }
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function putToSignedUrl(
  url: string,
  file: File,
  options: {
    method?: string;
    headers?: Record<string, string>;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? 'PUT', url, true);

    // Only the headers the signed URL was minted for. Adding others can break
    // the signature, which surfaces as an opaque 403 from storage.
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.({
        fraction: event.total > 0 ? event.loaded / event.total : 0,
        loadedBytes: event.loaded,
        totalBytes: event.total,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // 100% of bytes sent. Emphatically not "the book is processed".
        options.onProgress?.({ fraction: 1, loadedBytes: file.size, totalBytes: file.size });
        resolve();
        return;
      }
      reject(
        new UploadFailure(
          'Storage rejected the upload. The upload link may have expired — start the upload again.',
          xhr.status,
        ),
      );
    };

    xhr.onerror = () =>
      reject(new UploadFailure('The connection dropped while uploading. Try again.'));
    xhr.ontimeout = () => reject(new UploadFailure('The upload timed out. Try again.'));
    xhr.onabort = () => reject(new UploadFailure('The upload was cancelled.'));

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}

export interface FileValidationResult {
  ok: boolean;
  /** User-facing reason, when `ok` is false. */
  reason?: string;
  sourceKind?: 'PDF' | 'EPUB';
  mimeType?: string;
}

/**
 * Client-side admission check.
 *
 * The accepted types and the size ceiling both come from `/capabilities`
 * (`api-usage-guide.md` §2 — read the limits, do not hard-code them), so this
 * cannot drift from what the server will accept. Some browsers report an empty
 * `type` for `.epub`, so the extension is used as a fallback signal — the
 * server sniffs the real format regardless.
 */
export function validateSourceFile(
  file: File,
  limits: { acceptedMimeTypes: string[]; maxBytes: number | null },
): FileValidationResult {
  const name = file.name.toLowerCase();
  const byExtension = name.endsWith('.pdf')
    ? { mime: 'application/pdf', kind: 'PDF' as const }
    : name.endsWith('.epub')
      ? { mime: 'application/epub+zip', kind: 'EPUB' as const }
      : null;

  const mimeType = file.type || byExtension?.mime || '';
  if (!mimeType || !limits.acceptedMimeTypes.includes(mimeType)) {
    return {
      ok: false,
      reason: `“${file.name}” is not a supported format. Upload a PDF or EPUB.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, reason: `“${file.name}” is empty.` };
  }
  if (limits.maxBytes !== null && file.size > limits.maxBytes) {
    return {
      ok: false,
      reason: `“${file.name}” is larger than this workspace allows.`,
    };
  }

  const sourceKind = mimeType === 'application/pdf' ? 'PDF' : 'EPUB';
  return { ok: true, sourceKind, mimeType };
}

/**
 * The whole three-call upload, as one operation.
 *
 * Lives here rather than in a React hook because the book id only exists
 * *during* the flow on the create-project screen — a hook bound to an id at
 * render time would have nothing to bind to.
 *
 * The `Idempotency-Key` for the completion call is minted **once** and reused
 * across retries of the same intent, which is exactly what makes a retry after
 * a network timeout safe: the client cannot know whether the first call landed,
 * and with the same key it does not have to (`error-handling.md` §6).
 */
export async function uploadSourceFile({
  bookId,
  file,
  limits,
  onPhase,
  allowDuplicate,
  signal,
}: {
  bookId: string;
  file: File;
  limits: { acceptedMimeTypes: string[]; maxBytes: number | null };
  onPhase: (phase: UploadPhase) => void;
  allowDuplicate?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { post, newIdempotencyKey } = await import('./api/client');

  const validation = validateSourceFile(file, limits);
  if (!validation.ok) throw new UploadFailure(validation.reason ?? 'That file cannot be used.');

  onPhase({ kind: 'hashing' });
  const hash = await sha256Hex(file);

  onPhase({ kind: 'requesting' });
  const session = await post<{
    id: string;
    upload_targets: { url: string; method?: string; headers?: Record<string, string> }[];
  }>(`/api/v1/books/${bookId}/upload-sessions`, {
    body: {
      file_name: file.name,
      declared_mime_type: validation.mimeType ?? file.type,
      declared_size_bytes: file.size,
      declared_content_hash: { algorithm: 'SHA256', value: hash },
      source_kind: validation.sourceKind,
      ...(allowDuplicate ? { allow_duplicate: true } : {}),
    },
    idempotencyKey: newIdempotencyKey(),
    signal,
  });

  const target = session.upload_targets?.[0];
  if (!target?.url) {
    throw new UploadFailure('The server did not return an upload target for this file.');
  }

  onPhase({ kind: 'uploading', fraction: 0 });
  await putToSignedUrl(target.url, file, {
    method: target.method ?? 'PUT',
    headers: target.headers,
    signal,
    onProgress: (progress) => onPhase({ kind: 'uploading', fraction: progress.fraction }),
  });

  onPhase({ kind: 'finalizing' });
  await post(`/api/v1/books/${bookId}/upload-sessions/${session.id}/completion`, {
    body: { observed_size_bytes: file.size },
    idempotencyKey: newIdempotencyKey(),
    signal,
  });
}

export type UploadPhase =
  | { kind: 'hashing' }
  | { kind: 'requesting' }
  | { kind: 'uploading'; fraction: number }
  | { kind: 'finalizing' };
