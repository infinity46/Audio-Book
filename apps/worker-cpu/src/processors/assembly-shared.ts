/**
 * Shared plumbing for the three Phase 6 assembly handlers
 * (assembly-chapter.ts / assembly-audiobook.ts / assembly-encode.ts):
 * the audio-tool ModelVersion lookup, manifest hashing, temp-directory
 * lifecycle, and the small error-formatting helpers `ingestion.ts` also
 * uses (duplicated rather than imported from `processors/ingestion.ts`
 * since those are module-private there, not exported).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@audio-book/database';
import { DependencyFailureError } from '@audio-book/errors';
import { getFfmpegVersion } from '../lib/ffmpeg.js';

export const PRODUCER = 'worker-cpu';
export const PRODUCER_VERSION = '1.0.0';
export const ASSEMBLY_PIPELINE_VERSION = 'assembly.v1';

const AUDIO_TOOL_IDENTITY = { providerId: 'ffmpeg', modelId: 'ffmpeg' } as const;

/**
 * Resolves the `audio_tool_model_version_id` FK every assembly artifact
 * (`ChapterAudio`, `Audiobook`, `AudiobookRendition`) carries. Mirrors
 * `processors/ingestion.ts`'s `resolveModelVersionId` exactly: looks up the
 * `ModelRegistry` row by the fixed (`AUDIO_TOOL`, `ffmpeg`, `ffmpeg`)
 * identity, then the `ModelVersion` by whatever `ffmpeg -version` the
 * running container ACTUALLY reports — never a hardcoded string. A mismatch
 * against `infra/scripts/seed.ts`'s `AUDIO_TOOL_MODEL_VERSIONS` entry throws
 * `DependencyFailureError` and fails the job loudly rather than recording
 * wrong provenance (the same "no silent fallback" contract used everywhere
 * else `resolveModelVersionId`-shaped lookups appear in this codebase).
 */
export async function resolveAudioToolModelVersionId(prisma: PrismaClient): Promise<string> {
  const version = await getFfmpegVersion();
  const registry = await prisma.modelRegistry.findUnique({
    where: {
      role_providerId_modelId: {
        role: 'AUDIO_TOOL',
        providerId: AUDIO_TOOL_IDENTITY.providerId,
        modelId: AUDIO_TOOL_IDENTITY.modelId,
      },
    },
  });
  if (!registry) {
    throw new DependencyFailureError({
      message: `No ModelRegistry entry for AUDIO_TOOL/${AUDIO_TOOL_IDENTITY.providerId}/${AUDIO_TOOL_IDENTITY.modelId}. Run the seed script before assembling.`,
    });
  }
  const modelVersion = await prisma.modelVersion.findFirst({
    where: { modelRegistryId: registry.id, version },
  });
  if (!modelVersion) {
    throw new DependencyFailureError({
      message:
        `Installed ffmpeg reports version ${version}, but no ModelVersion ${version} is ` +
        `registered for AUDIO_TOOL/ffmpeg/ffmpeg. Update infra/scripts/seed.ts's ` +
        `AUDIO_TOOL_MODEL_VERSIONS entry (or the installed ffmpeg) so they match.`,
    });
  }
  return modelVersion.id;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * `chunk_manifest_hash` / `chapter_manifest_hash` formula, verbatim and
 * reproducible: SHA-256 hex over the ordered list of `${id}:${contentHash}`
 * pairs, joined by `\n`. Both assembly idempotency checks (re-run on an
 * unchanged manifest = no-op) and both fan-in fingerprints depend on this
 * being deterministic for a given ordered input.
 */
export function computeManifestHash(parts: string[]): string {
  return sha256Hex(parts.join('\n'));
}

/** Runs `fn` against a fresh, uniquely-named temp directory, always removing it afterward (success, failure, or thrown error alike). */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCodeOf(err: unknown, fallback: string): string {
  return err instanceof Error &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : fallback;
}

export function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/**
 * The intent an API-side `POST /books/{bookId}/assembly` request threads
 * onto its coordinating `assemble_chapter`/`assemble_audiobook`
 * `ProcessingJob.scope` (a `Json?` column, `prisma/schema.prisma`) —
 * mirroring the request body's own `scope`/`delivery_formats` fields
 * (`api-specification.md` §16.16). This worker does not own that API
 * module (built in parallel), so this type is read defensively: an
 * absent/unparseable `scope` column is treated as "no opinion", never as
 * `AUDIOBOOK`, so an ad-hoc `CHAPTERS`-scope re-assembly can never
 * accidentally balloon into a full audiobook rebuild (see
 * `maybeTriggerAudiobookFanIn` in assembly-chapter.ts).
 */
export interface AssemblyJobScope {
  scope?: 'AUDIOBOOK' | 'CHAPTERS';
  delivery_formats?: string[];
}

export function readJobScope(scope: unknown): AssemblyJobScope | null {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  return scope as AssemblyJobScope;
}

export interface AudiobookReadiness {
  ready: boolean;
  bookVersionId: string | null;
}

/**
 * The DB-query-driven fan-in readiness check (`event-contracts.md` §31.2:
 * "Completion is determined from persistent database state. Never from
 * counting queue messages."). A book is ready for `assemble_audiobook` once
 * every current `Chapter` of its current `BookVersion` has a current
 * `ChapterAudio` with `status = 'ASSEMBLED'`. Idempotent and re-runnable —
 * asking twice gives the same answer — which is exactly what makes it safe
 * to call both from the chapter handler's auto-fan-in trigger AND from the
 * audiobook handler's own guard (redundant, not wasteful: self-healing per
 * §31.2's second property).
 */
export async function checkAudiobookReadiness(
  prisma: PrismaClient,
  bookId: string,
): Promise<AudiobookReadiness> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { currentBookVersionId: true },
  });
  if (!book?.currentBookVersionId) {
    return { ready: false, bookVersionId: null };
  }
  const totalChapters = await prisma.chapter.count({
    where: { bookVersionId: book.currentBookVersionId },
  });
  if (totalChapters === 0) {
    return { ready: false, bookVersionId: book.currentBookVersionId };
  }
  const notReadyChapters = await prisma.chapter.count({
    where: {
      bookVersionId: book.currentBookVersionId,
      chapterAudios: { none: { isCurrent: true, status: 'ASSEMBLED' } },
    },
  });
  return { ready: notReadyChapters === 0, bookVersionId: book.currentBookVersionId };
}

/**
 * Recovers the FULL set of delivery formats originally requested for an
 * `Audiobook`, so `processEncodeDeliveryFormatJob` (assembly-encode.ts) can
 * tell "every requested format is now READY" from "only the format THIS
 * job just encoded is READY" — the trigger for `Audiobook.status → READY`.
 *
 * `Audiobook` carries no `requestedDeliveryFormats` column, and using
 * `ProcessingJob.parentJobId` to group sibling `encode_delivery_format` jobs
 * breaks across a packaging-only retry (assembly-audiobook.ts's
 * resumability path creates a NEW `assemble_audiobook` `ProcessingJob` —
 * and therefore a new `parentJobId` — for the missing formats only, so the
 * already-`READY` format's original encode job has a DIFFERENT parent).
 * `relatedResourceId` does not have that problem: every `encode_delivery_format`
 * job ever created for this `Audiobook`, across every resumption, points at
 * the same `audiobookId`. Each such job records its own `format` on its
 * `scope` column (a generic `Json?`, reused here the same way
 * `assemble_chapter`/`assemble_audiobook` reuse it for `AssemblyJobScope`)
 * — see `enqueueEncodeJobs` in assembly-audiobook.ts.
 */
export async function resolveRequestedDeliveryFormats(
  prisma: PrismaClient,
  audiobookId: string,
): Promise<string[]> {
  const rows = await prisma.processingJob.findMany({
    where: {
      type: 'encode_delivery_format',
      relatedResourceType: 'audiobook',
      relatedResourceId: audiobookId,
    },
    select: { scope: true },
  });
  const formats = new Set<string>();
  for (const row of rows) {
    const scope = row.scope as { format?: string } | null;
    if (scope?.format) formats.add(scope.format);
  }
  return [...formats];
}
