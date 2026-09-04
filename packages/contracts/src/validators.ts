import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats only ships a CJS default export; under this repo's
// moduleResolution (NodeNext) TypeScript mis-types that default import as
// the whole module namespace rather than the callable plugin (a known
// ajv-formats/TS-NodeNext interop gap). The runtime shape is fine (Node's
// CJS interop unwraps it correctly) — only the static type is wrong, so we
// import raw and assert the type we know is correct at runtime.
import addFormatsRaw from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const addFormats = addFormatsRaw as unknown as (ajv: Ajv) => Ajv;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/validators.js -> ../schemas ; src/validators.ts (ts-node/vitest) -> ../schemas
const schemasDir = path.resolve(here, '..', 'schemas');

function loadSchema(fileName: string): object {
  const raw = readFileSync(path.join(schemasDir, fileName), 'utf8');
  return JSON.parse(raw) as object;
}

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export const commandEnvelopeSchema = loadSchema('command-envelope.schema.json');
export const eventEnvelopeSchema = loadSchema('event-envelope.schema.json');
export const createBookSchema = loadSchema('create-book.schema.json');
export const createUploadSessionSchema = loadSchema('create-upload-session.schema.json');
export const completeUploadSessionSchema = loadSchema('complete-upload-session.schema.json');
export const requestIngestionSchema = loadSchema('request-ingestion.schema.json');
export const startAnalysisSchema = loadSchema('start-analysis.schema.json');
export const updateCharacterSchema = loadSchema('update-character.schema.json');
export const createCharacterAliasSchema = loadSchema('create-character-alias.schema.json');
export const updateCharacterAliasSchema = loadSchema('update-character-alias.schema.json');
export const createCharacterMergeSchema = loadSchema('create-character-merge.schema.json');
export const createPronunciationEntrySchema = loadSchema('create-pronunciation-entry.schema.json');
export const updatePronunciationEntrySchema = loadSchema('update-pronunciation-entry.schema.json');
export const startDirectorSchema = loadSchema('start-director.schema.json');
export const reviseDirectorSchema = loadSchema('revise-director.schema.json');
export const updateAudioScriptChunkSchema = loadSchema('update-audio-script-chunk.schema.json');
export const startTtsSchema = loadSchema('start-tts.schema.json');
export const createVoiceProfileSchema = loadSchema('create-voice-profile.schema.json');
export const updateVoiceProfileSchema = loadSchema('update-voice-profile.schema.json');
export const createVoiceProfileVersionSchema = loadSchema(
  'create-voice-profile-version.schema.json',
);
export const approveVoiceProfileVersionSchema = loadSchema(
  'approve-voice-profile-version.schema.json',
);
export const lockVoiceProfileVersionSchema = loadSchema('lock-voice-profile-version.schema.json');
export const createVoicePreviewSchema = loadSchema('create-voice-preview.schema.json');
export const assignVoiceSchema = loadSchema('assign-voice.schema.json');
export const narratorFallbackSchema = loadSchema('narrator-fallback.schema.json');
export const createAccessUrlSchema = loadSchema('create-access-url.schema.json');
export const startAssemblySchema = loadSchema('start-assembly.schema.json');
export const updateAudiobookMetadataSchema = loadSchema('update-audiobook-metadata.schema.json');

// --- Phase 8 application layer (api-specification.md §16.2, §16.5, §16.18, §16.22) ---
export const cancelJobSchema = loadSchema('cancel-job.schema.json');
export const updateBookSchema = loadSchema('update-book.schema.json');
export const updateCurrentUserSchema = loadSchema('update-current-user.schema.json');
export const updateTenantQuotasSchema = loadSchema('update-tenant-quotas.schema.json');
export const replayJobSchema = loadSchema('replay-job.schema.json');

// --- Phase 10 identity/auth (api-specification.md §16.1) ---
export const registerSchema = loadSchema('register.schema.json');
export const loginSchema = loadSchema('login.schema.json');
export const mfaExchangeSchema = loadSchema('mfa-exchange.schema.json');
export const refreshTokenSchema = loadSchema('refresh-token.schema.json');
export const passwordResetRequestSchema = loadSchema('password-reset-request.schema.json');
export const passwordResetConfirmSchema = loadSchema('password-reset-confirm.schema.json');
export const restoreBookSchema = loadSchema('restore-book.schema.json');
export const purgeBookSchema = loadSchema('purge-book.schema.json');

export const validateCommandEnvelope: ValidateFunction = ajv.compile(commandEnvelopeSchema);
export const validateEventEnvelope: ValidateFunction = ajv.compile(eventEnvelopeSchema);

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function runValidator(validator: ValidateFunction, data: unknown): ValidationResult {
  const valid = validator(data);
  if (valid) return { valid: true };
  return {
    valid: false,
    errors: (validator.errors ?? []).map((e) =>
      `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim(),
    ),
  };
}
