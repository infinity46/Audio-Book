/**
 * Typed mirror of the Phase 8 Application API (`docs/architecture/api-specification.md`,
 * `docs/application/api-usage-guide.md`).
 *
 * These are hand-written rather than generated because the API ships JSON
 * Schemas for *requests* only (`packages/contracts/schemas`) — there is no
 * response schema to generate from. `src/test/contract/api-contract.test.ts`
 * asserts the closed vocabularies below against the enums the API actually
 * serves, so drift is a test failure rather than a silent divergence
 * (Phase 9 rules 164–166).
 *
 * Every enum here is a **closed vocabulary** per `api-specification.md` §7.6.
 * Client code must still treat an unrecognized value as unknown rather than
 * crashing — `api-usage-guide.md` §7 requires it — which is why the display
 * mappings in `src/lib/status.ts` all have a fallback branch.
 */

// ---------------------------------------------------------------- envelopes --

export interface Envelope<T> {
  data: T;
}

export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  prev_cursor: string | null;
  total: number | null;
}

export interface Collection<T> {
  data: T[];
  page: PageInfo;
}

/** `api-specification.md` §8 — the one failure envelope, from every endpoint. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field?: string; issue: string }[];
    request_id: string | null;
    trace_id: string | null;
    retryable: boolean;
    documentation_url?: string | null;
  };
}

/** `202` bodies: `{ job, accepted }` (`api-usage-guide.md` §5). */
export interface AcceptedCommand {
  job: JobHandle;
  accepted: {
    scope: string;
    planned_unit_count: number | null;
    skipped_unit_count: number | null;
    skip_reason?: string | null;
    [k: string]: unknown;
  };
}

export interface JobHandle {
  id: string;
  object: 'job';
  type: string;
  /** `202` acceptance status is restricted to these three (§9.3). */
  status: 'CREATED' | 'QUEUED' | 'BLOCKED';
  book_id: string | null;
  links?: { self: string };
}

// -------------------------------------------------------- closed vocabularies --

/** `api-specification.md` §20.1 / `context.md` §4.4 — sixteen states, closed. */
export const BOOK_STATUSES = [
  'CREATED',
  'UPLOADED',
  'PARSING',
  'PARSED',
  'STRUCTURED',
  'ANALYZING',
  'ANALYZED',
  'CASTING',
  'SCRIPTING',
  'SCRIPTED',
  'GENERATING',
  'ASSEMBLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_REVIEW',
] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

/** `api-usage-guide.md` §8 — exactly nine; the last four are terminal. */
export const JOB_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'BLOCKED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'DEAD_LETTERED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'DEAD_LETTERED',
];

/** `api-specification.md` §20.5 — the derived stage projection. */
export const STAGE_STATUSES = [
  'NOT_STARTED',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'BLOCKED',
  'PARTIAL',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_NAMES = ['ingestion', 'analysis', 'director', 'tts', 'assembly'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** `api-usage-guide.md` §10 — the closed `review_flags[]` vocabulary. */
export const REVIEW_FLAGS = [
  'DIRECTOR_FALLBACK',
  'UNKNOWN_SPEAKER',
  'LOW_CONFIDENCE',
  'CHARACTER_METADATA_CHANGED',
  'PRONUNCIATION_LEXICON_CHANGED',
  'CAPABILITY_GAP',
  'TEXT_HASH_MISMATCH',
] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

/** `assembly.service.ts` — the `audiobook_project` lifecycle field. */
export const GENERATION_STATUSES = [
  'NOT_STARTED',
  'BLOCKED',
  'ASSEMBLING',
  'COMPLETED',
  'FAILED',
  'STALE',
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export type VoiceApprovalState = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'RETIRED';
export type VoiceLockState = 'UNLOCKED' | 'LOCKED';

/** Source formats the backend admits (`platform.service.ts` upload vocabulary). */
export const ACCEPTED_MIME_TYPES = ['application/pdf', 'application/epub+zip'] as const;
export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];
export type SourceKind = 'PDF' | 'EPUB';

// ------------------------------------------------------------------ resources --

export interface Book {
  id: string;
  object: 'book';
  tenant_id: string;
  title: string;
  author: string | null;
  language: string;
  description: string | null;
  metadata: {
    series: string | null;
    series_index: number | null;
    publication_year: number | null;
    publisher: string | null;
  };
  status: BookStatus;
  pipeline_version: string;
  needs_review: boolean;
  current_book_version_id: string | null;
  current_audio_script_id: string | null;
  /** QA finding F-16: never written. `GET .../audiobook` is the reliable pointer. */
  current_audiobook_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  links: Record<string, string>;
}

/** The compact per-stage summary embedded by `?include=stages` (§16.5). */
export type StageSummary = Record<
  StageName,
  {
    status: StageStatus;
    progress: number | null;
    completed_units: number;
    total_units: number | null;
  }
>;

export type BookWithStages = Book & { stages: StageSummary };

export interface StageProgress {
  stage: StageName;
  status: StageStatus;
  /** `0.0`–`1.0`, or `null` when the denominator is not yet knowable. */
  progress: number | null;
  completed_units: number;
  /** `null` ≠ `0`: `null` means "not measurable yet" (`api-usage-guide.md` §7). */
  total_units: number | null;
  failed_units: number;
  flagged_units: number;
}

export interface BookProgress {
  object: 'book_progress';
  book_id: string;
  book_status: BookStatus;
  overall_progress: number | null;
  degraded: boolean;
  degraded_reasons: string[];
  stages: StageProgress[];
  active_job_ids: string[];
  needs_review: boolean;
  needs_review_count: number;
  estimate: {
    remaining_ms: number | null;
    /** Capped at `LOW` by contract — the server refuses to guess harder. */
    confidence: 'NONE' | 'LOW';
    basis: string | null;
    computed_at: string | null;
  };
  queue: { position: number | null; backpressure: string | null };
  updated_at: string;
  links: Record<string, string>;
}

export interface BookFile {
  id: string;
  object: 'book_file';
  book_id: string;
  source_kind: SourceKind;
  original_file_name: string;
  mime_type: string;
  sniffed_mime_type: string | null;
  size_bytes: number;
  content_hash: { algorithm: string; value: string };
  status: string;
  validation: unknown;
  created_at: string;
  updated_at: string;
}

export interface UploadSession {
  id: string;
  object: 'upload_session';
  book_id: string;
  status: string;
  upload_targets: { url: string; method: string; headers?: Record<string, string> }[];
  expires_at: string;
  [k: string]: unknown;
}

export interface Chapter {
  id: string;
  order_index: number;
  spine_start: number;
  spine_end: number;
  title: string | null;
  matter_type: string;
  char_count: number;
  text_qc_outcome: string | null;
}

export interface Character {
  id: string;
  object: 'character';
  book_id: string;
  display_name: string;
  status: string;
  is_sentinel: boolean;
  sentinel_kind: string | null;
  importance_rank: number | null;
  line_count: number;
  speaking: boolean;
  pronoun_sets: unknown;
  speech_traits: unknown;
  first_appearance: { chapter_id: string | null; paragraph_id: string | null };
  last_appearance: { chapter_id: string | null; paragraph_id: string | null };
  detection: {
    source: string;
    model_version_id: string | null;
    confidence: number | null;
    evidence_paragraph_ids: string[];
  };
  merged_into_character_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterAlias {
  id: string;
  object: 'character_alias';
  character_id: string;
  surface_form: string;
  alias_type: string;
  scope: { kind: string; chapter_id: string | null; speaker_character_id: string | null };
  source: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceProfile {
  id: string;
  object: 'voice_profile';
  tenant_id: string | null;
  scope: 'SYSTEM' | 'TENANT' | 'BOOK';
  book_id: string | null;
  name: string;
  description: string | null;
  active_version: number | null;
  lock_state: VoiceLockState;
  version_count: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceProfileVersion {
  id: string;
  object: 'voice_profile_version';
  voice_profile_id: string;
  version: number;
  supersedes_version_id: string | null;
  approval_state: VoiceApprovalState;
  lock_state: VoiceLockState;
  locked_at: string | null;
  locked_reason: string | null;
  tts_provider_id: string;
  tts_model_version_id: string;
  language: string;
  supported_languages: string[];
  base_generation_params: unknown;
  base_generation_params_hash: string;
  emotion_capability_map: unknown;
  consent: { attested: boolean; subject: string };
  created_at: string;
  updated_at: string;
}

export interface VoicePreview {
  id: string;
  object: 'voice_preview';
  voice_profile_id: string;
  voice_profile_version: number;
  status: string;
  book_id: string | null;
  character_id: string | null;
  text_excerpt: string;
  emotion: string;
  capability_gap: unknown;
  duration_ms: number | null;
  sample_rate: number | null;
  job_id: string | null;
  error: { code: string } | null;
  created_at: string;
}

export interface VoiceAssignment {
  object: 'voice_assignment';
  book_id: string;
  character_id: string;
  voice_profile_id: string;
  voice_profile_version: number;
  approval_state: VoiceApprovalState;
  assigned_at: string;
  /** Present on `PUT` only — the honest basis for the regeneration warning. */
  impact?: {
    chunks_bound_to_previous_version: number;
    requires_regeneration: boolean;
    estimated_regeneration_units: number;
  };
}

export interface CastingState {
  object: 'casting_state';
  book_id: string;
  ready_for_generation: boolean;
  speaking_character_count: number;
  assigned_count: number;
  approved_count: number;
  blocking: {
    character_id: string;
    display_name: string;
    line_count: number;
    reason: string;
  }[];
}

export interface AudioScript {
  id: string;
  object: 'audio_script';
  book_id: string;
  version: number;
  state: 'DRAFT' | 'VALIDATED' | 'SUPERSEDED' | 'INVALID';
  chunk_count: number;
  totals: { characters: number; estimated_audio_ms: number };
  coverage_verified: boolean;
  coverage_gap_count: number;
  unknown_speaker_rate: number | null;
  fallback_applied_count: number;
  low_confidence_chunk_count: number;
  degraded: boolean;
  director_version: string;
  created_at: string;
  updated_at: string;
}

export interface AudioScriptChunk {
  id: string;
  object: 'audio_script_chunk';
  audio_script_id: string;
  book_id: string;
  chapter_id: string;
  sequence_index: number;
  chapter_sequence_index: number;
  state: string;
  content: {
    /** UNTRUSTED book text — render as text, never as HTML (Phase 9 rules 123–125). */
    text: string;
    spoken_text: string | null;
    language: string;
    script: string | null;
  };
  performance: {
    speaker_type: string;
    character_id: string | null;
    is_dialogue: boolean;
    delivery_mode: string;
    emotion: string;
    emotion_intensity: number;
    pacing: number;
    pitch: number;
    volume: number;
    [k: string]: unknown;
  };
  binding?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  confidence: number;
  review_flags: ReviewFlag[];
  fallback_applied: boolean;
  fallback_reason: string | null;
  capability_gaps: unknown;
  current_audio_chunk_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AudioChunk {
  id: string;
  object: 'audio_chunk';
  book_id: string;
  chapter_id: string | null;
  audio_script_chunk_id: string;
  generation_version: number;
  is_current: boolean;
  status: string;
  validation_status: string | null;
  duration_ms: number | null;
  capability_gaps?: unknown;
  created_at: string;
  links?: Record<string, string>;
  [k: string]: unknown;
}

export interface ChapterAudio {
  id: string;
  object: 'chapter_audio';
  book_id: string;
  chapter_id: string;
  version: number;
  supersedes_chapter_audio_id: string | null;
  is_current: boolean;
  is_preview_build: boolean;
  status: string;
  technical: { duration_ms: number | null; chunk_count: number | null; format: string | null };
  chunk_manifest_hash: string | null;
  loudness: { integrated_lufs: number | null; true_peak_dbtp: number | null };
  lineage: Record<string, string>;
  created_at: string;
  links: Record<string, string>;
}

export interface AudiobookProject {
  object: 'audiobook_project';
  book_id: string;
  generation_status: GenerationStatus;
  current_audiobook_id: string | null;
  current_version: number | null;
  version_count: number;
  chapters: {
    chapter_id: string;
    order_index: number;
    title: string | null;
    chapter_audio_id: string | null;
    status: string;
    duration_ms: number | null;
  }[];
  totals: { chapters: number; chapters_assembled: number; duration_ms: number };
  blocking: string[];
  links: Record<string, string | null>;
}

export interface Audiobook {
  id: string;
  object: 'audiobook';
  book_id: string;
  version: number;
  supersedes_audiobook_id: string | null;
  is_current: boolean;
  is_preview_build: boolean;
  status: string;
  container_format: string;
  available_formats: string[];
  duration_ms: number | null;
  size_bytes: number | null;
  chapter_manifest: {
    chapter_id: string;
    chapter_audio_id: string;
    order_index: number;
    title: string | null;
    start_ms: number;
    duration_ms: number;
  }[];
  metadata: {
    title: string | null;
    author: string | null;
    narrator_credit: string | null;
    ai_narration_disclosed: boolean;
    series: string | null;
    series_index: number | null;
    publisher: string | null;
    language: string | null;
    publication_year: number | null;
    description: string | null;
  };
  cover: { present: boolean; width?: number; height?: number; content_hash?: string };
  quality: { book_wer: number | null; chunks_flagged: number | null; asr_coverage: number | null };
  lineage: Record<string, unknown>;
  created_at: string;
  links: Record<string, string>;
}

/** `api-specification.md` §16.20 — the uniform binary-access response. */
export interface AccessUrl {
  object: 'access_url';
  url: string;
  method: string;
  expires_at: string;
  content_type: string | null;
  size_bytes: number | null;
  content_hash: { algorithm: string; value: string } | null;
  [k: string]: unknown;
}

export interface Job {
  id: string;
  object: 'job';
  type: string;
  status: JobStatus;
  book_id: string | null;
  parent_job_id: string | null;
  attempt_count: number;
  max_attempts: number | null;
  next_attempt_at: string | null;
  cancellation?: {
    requested: boolean;
    requested_at: string | null;
    requested_by: string | null;
    effective: boolean;
  };
  /** `null` in every non-terminal state — the API never predicts an outcome. */
  result: unknown;
  error: {
    code: string;
    class?: string;
    message: string;
    retryable: boolean;
    terminal: boolean;
    attempt_number?: number;
  } | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  links?: Record<string, string>;
  [k: string]: unknown;
}

export interface CancellationResult {
  status: JobStatus;
  cancellation: {
    requested: boolean;
    requested_at: string | null;
    requested_by: string | null;
    /** `false` on a `RUNNING` job means the work has NOT stopped yet. */
    effective: boolean;
  };
}

export interface Capabilities {
  object: 'capabilities';
  api_version: string;
  degraded: boolean;
  degraded_reasons: string[];
  limits: {
    max_page_limit: number;
    default_page_limit: number;
    max_request_body_bytes: number;
    max_upload_bytes: Record<string, number>;
    signed_url_max_expiry_seconds: number;
    max_batch_ids: number;
    max_pages_per_book: number;
  };
  upload: {
    accepted_mime_types: string[];
    multipart_threshold_bytes: number | null;
  };
  tts_providers: {
    tts_provider_id: string;
    model_id: string;
    model_version_id: string;
    version: string;
    capabilities: unknown;
    available: boolean | null;
  }[];
  director_versions: { director_version: string; model_id: string; current: boolean }[];
  delivery_formats: string[];
  vocabularies: { emotion: string[]; delivery_mode: string[] };
  links: Record<string, string>;
}

export interface CurrentUser {
  id: string;
  object: 'user';
  tenant_id: string;
  email: string | null;
  display_name: string | null;
  roles: string[];
  preferences?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Quotas {
  object: string;
  degraded: boolean;
  degraded_reasons?: string[];
  quotas: {
    dimension: string;
    limit: number | null;
    /** `null` while the aggregator is unavailable — the read fails open. */
    used: number | null;
  }[];
  [k: string]: unknown;
}

/** `api-specification.md` §16.2 — `GET /users/me/sessions` (Phase 10). */
export interface Session {
  id: string;
  object: 'session';
  created_at: string;
  last_seen_at: string | null;
  user_agent_family: string | null;
  ip_country: string | null;
  /** Whether this is the session the current request is authenticated with. */
  current: boolean;
}

// ---------------------------------------------------------- command payloads --

export type StageCommandScope = 'BOOK' | 'CHAPTERS' | 'CHUNKS' | 'FILTER' | 'AUDIOBOOK';

export interface StageCommandBody {
  /**
   * Absent for `POST .../ingestion`, whose request schema takes `book_file_id`
   * and nothing else — the API rejects unknown fields with `422
   * unknown_field`, so a `scope` sent there would be refused.
   */
  scope?: StageCommandScope;
  chapter_ids?: string[];
  chunk_ids?: string[];
  filter?: Record<string, unknown>;
  force?: boolean;
  delivery_formats?: string[];
  book_file_id?: string;
  [k: string]: unknown;
}
