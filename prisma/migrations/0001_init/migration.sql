-- =============================================================================
-- Prerequisite extensions
-- =============================================================================
-- These three statements are the ONE necessary deviation (beyond the audit_log
-- partitioning edit near the bottom of this file, and the citext type-widening
-- ALTER appended at the end) from "append only, never touch the generated DDL":
-- `narrative_embedding.embedding` below is declared with the raw PostgreSQL
-- type `vector(1536)` (Prisma emitted this literally from the schema's
-- `Unsupported("vector(1536)")` annotation — see schema.prisma line ~2046).
-- `CREATE TYPE`/`CREATE TABLE` statements that reference a type are resolved
-- at execution time in file order, so the extension that defines `vector` MUST
-- run before the `CREATE TABLE "narrative_embedding"` statement below, which
-- makes it impossible to satisfy "purely additive, appended after" for pgvector
-- specifically. `citext` and `btree_gist` have no such ordering constraint (both
-- are only ever used in the appended section at the bottom of this file, after
-- the base DDL) but are bootstrapped here too, once, for a single obvious
-- extensions block rather than splitting extension setup across the file.
-- See prisma/README.md.
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "principal_role" AS ENUM ('TENANT_OWNER', 'TENANT_MEMBER', 'PLATFORM_ADMIN', 'SERVICE', 'WORKER');

-- CreateEnum
CREATE TYPE "provider_kind" AS ENUM ('LOCAL', 'OIDC');

-- CreateEnum
CREATE TYPE "usage_metric" AS ENUM ('CONCURRENT_BOOKS', 'GPU_MINUTES', 'STORAGE_BYTES', 'BOOKS_TOTAL', 'LLM_TOKENS');

-- CreateEnum
CREATE TYPE "book_status" AS ENUM ('CREATED', 'UPLOADED', 'PARSING', 'PARSED', 'STRUCTURED', 'ANALYZING', 'ANALYZED', 'CASTING', 'SCRIPTING', 'SCRIPTED', 'GENERATING', 'ASSEMBLING', 'COMPLETED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "book_file_status" AS ENUM ('ADMITTED', 'REJECTED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "book_source_kind" AS ENUM ('PDF', 'EPUB', 'IMAGE_SET');

-- CreateEnum
CREATE TYPE "book_version_status" AS ENUM ('CREATED', 'PARSING', 'PARSED', 'NORMALIZED', 'STRUCTURED', 'READY', 'PARTIAL_OCR', 'NEEDS_REVIEW', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "matter_type" AS ENUM ('FRONT_MATTER', 'BODY', 'BACK_MATTER');

-- CreateEnum
CREATE TYPE "extraction_method" AS ENUM ('DIGITAL_TEXT', 'OCR', 'EPUB_SPINE', 'IMAGE_OCR');

-- CreateEnum
CREATE TYPE "text_qc_outcome" AS ENUM ('PASS', 'WARN', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "parsed_page_status" AS ENUM ('OK', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "validation_status" AS ENUM ('PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "character_status" AS ENUM ('CONFIRMED', 'PROVISIONAL', 'MERGED_INTO', 'RETIRED');

-- CreateEnum
CREATE TYPE "character_sentinel" AS ENUM ('NARRATOR', 'UNKNOWN_SPEAKER', 'MULTIPLE_SPEAKERS', 'SYSTEM');

-- CreateEnum
CREATE TYPE "character_alias_type" AS ENUM ('GIVEN_NAME', 'FULL_NAME', 'SURNAME', 'NICKNAME', 'TITLE', 'EPITHET', 'DESCRIPTOR', 'RELATIONAL');

-- CreateEnum
CREATE TYPE "alias_scope" AS ENUM ('GLOBAL', 'CHAPTER', 'SPEAKER');

-- CreateEnum
CREATE TYPE "detection_source" AS ENUM ('NARRATIVE_UNDERSTANDING', 'DIRECTOR', 'USER');

-- CreateEnum
CREATE TYPE "extraction_source" AS ENUM ('EXTRACTED', 'USER');

-- CreateEnum
CREATE TYPE "merge_operation" AS ENUM ('MERGE', 'SPLIT');

-- CreateEnum
CREATE TYPE "resolution_strategy" AS ENUM ('EXPLICIT_ATTRIBUTION', 'EXACT_ALIAS', 'SCOPED_ALIAS', 'PRONOUN', 'TURN_TAKING', 'LLM_ADJUDICATION', 'FALLBACK');

-- CreateEnum
CREATE TYPE "relationship_type" AS ENUM ('FAMILY', 'ROMANTIC', 'FRIENDSHIP', 'RIVALRY', 'ADVERSARIAL', 'MENTOR', 'PROFESSIONAL', 'AUTHORITY', 'ALLIANCE', 'BETRAYAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "story_bible_status" AS ENUM ('NOT_BUILT', 'BUILDING', 'READY', 'STALE', 'FAILED');

-- CreateEnum
CREATE TYPE "story_bible_stale_reason" AS ENUM ('STRUCTURE_CHANGED', 'CHARACTERS_MERGED', 'SOURCE_TEXT_CHANGED');

-- CreateEnum
CREATE TYPE "story_bible_build_mode" AS ENUM ('INCREMENTAL', 'REBUILD');

-- CreateEnum
CREATE TYPE "context_layer" AS ENUM ('L1', 'L2', 'L3', 'L4', 'L5', 'L6');

-- CreateEnum
CREATE TYPE "summary_level" AS ENUM ('PARAGRAPH', 'SCENE', 'CHAPTER', 'PART', 'BOOK');

-- CreateEnum
CREATE TYPE "pov_type" AS ENUM ('FIRST', 'THIRD_LIMITED', 'THIRD_OMNISCIENT', 'SECOND', 'MIXED');

-- CreateEnum
CREATE TYPE "checkpoint_kind" AS ENUM ('SCENE_BOUNDARY', 'CHAPTER_BOUNDARY');

-- CreateEnum
CREATE TYPE "span_kind" AS ENUM ('NORMAL', 'FLASHBACK', 'FLASH_FORWARD');

-- CreateEnum
CREATE TYPE "narrative_thread_kind" AS ENUM ('OPEN_QUESTION', 'SECRET', 'DRAMATIC_IRONY', 'FORESHADOWING');

-- CreateEnum
CREATE TYPE "narrative_thread_status" AS ENUM ('OPEN', 'RESOLVED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "embedding_source_kind" AS ENUM ('SUMMARY', 'SCENE', 'PARAGRAPH');

-- CreateEnum
CREATE TYPE "pronunciation_scope" AS ENUM ('GLOBAL', 'CHARACTER', 'CHAPTER');

-- CreateEnum
CREATE TYPE "voice_profile_scope" AS ENUM ('TENANT', 'BOOK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "voice_approval_state" AS ENUM ('DRAFT', 'PREVIEW_GENERATED', 'APPROVED', 'LOCKED', 'RETIRED');

-- CreateEnum
CREATE TYPE "voice_lock_state" AS ENUM ('UNLOCKED', 'LOCKED');

-- CreateEnum
CREATE TYPE "voice_lock_reason" AS ENUM ('USED_IN_GENERATION', 'USER_LOCKED');

-- CreateEnum
CREATE TYPE "voice_preview_status" AS ENUM ('GENERATING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "voice_assignment_role" AS ENUM ('NARRATOR', 'CHARACTER', 'ALTERNATE');

-- CreateEnum
CREATE TYPE "consent_subject" AS ENUM ('SYNTHETIC', 'SELF', 'THIRD_PARTY_CONSENTED');

-- CreateEnum
CREATE TYPE "reference_provenance" AS ENUM ('UPLOADED', 'LIBRARY', 'SYNTHESIZED');

-- CreateEnum
CREATE TYPE "speaker_type" AS ENUM ('NARRATOR', 'CHARACTER', 'UNKNOWN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "delivery_mode" AS ENUM ('NORMAL', 'INTERNAL_THOUGHT', 'WHISPER', 'SHOUT', 'LAUGHING', 'CRYING', 'SINGING', 'READING_ALOUD');

-- CreateEnum
CREATE TYPE "emotion" AS ENUM ('NEUTRAL', 'HAPPY', 'SAD', 'GRIEF', 'ANGRY', 'FEARFUL', 'SURPRISED', 'DISGUSTED', 'EXCITED', 'CALM', 'TENSE', 'ANXIOUS', 'SOMBER', 'CONFIDENT', 'UNCERTAIN', 'PLAYFUL', 'SERIOUS');

-- CreateEnum
CREATE TYPE "audio_script_state" AS ENUM ('DRAFT', 'VALIDATED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "audio_script_chunk_state" AS ENUM ('DRAFT', 'VALIDATED', 'LOCKED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "audio_script_scope" AS ENUM ('BOOK', 'CHAPTER');

-- CreateEnum
CREATE TYPE "chunk_origin" AS ENUM ('AUTO_GENERATED', 'HUMAN_REVIEWED', 'HUMAN_MODIFIED', 'LOCKED');

-- CreateEnum
CREATE TYPE "review_flag" AS ENUM ('DIRECTOR_FALLBACK', 'UNKNOWN_SPEAKER', 'LOW_CONFIDENCE', 'CHARACTER_METADATA_CHANGED', 'PRONUNCIATION_LEXICON_CHANGED', 'CAPABILITY_GAP', 'TEXT_HASH_MISMATCH');

-- CreateEnum
CREATE TYPE "tts_job_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "audio_chunk_status" AS ENUM ('PENDING', 'GENERATING', 'GENERATED', 'VALIDATED', 'ASSEMBLED', 'FAILED', 'INVALID', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "chapter_audio_status" AS ENUM ('PENDING', 'ASSEMBLING', 'ASSEMBLED', 'INVALID', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "audiobook_status" AS ENUM ('DRAFT_METADATA', 'ASSEMBLING', 'READY', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "audio_format" AS ENUM ('WAV', 'FLAC', 'AAC', 'MP3');

-- CreateEnum
CREATE TYPE "delivery_format" AS ENUM ('M4B', 'M4A', 'MP3_PER_CHAPTER');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "job_type" AS ENUM ('parse_book', 'ocr_page', 'normalize_text', 'analyze_structure', 'analyze_scene', 'build_story_bible_delta', 'generate_director_ir', 'revise_director_ir', 'generate_voice_preview', 'generate_tts_chunk', 'validate_audio', 'process_audio', 'verify_transcript', 'assemble_chapter', 'assemble_audiobook', 'encode_delivery_format', 'cleanup_artifacts');

-- CreateEnum
CREATE TYPE "job_queue" AS ENUM ('parse', 'ai', 'gpu', 'audio', 'maintenance');

-- CreateEnum
CREATE TYPE "job_priority" AS ENUM ('INTERACTIVE', 'NORMAL', 'BULK');

-- CreateEnum
CREATE TYPE "attempt_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REAPED');

-- CreateEnum
CREATE TYPE "dependency_kind" AS ENUM ('UPSTREAM_JOB', 'HUMAN_GATE');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "inbox_outcome" AS ENUM ('PROCESSED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "resource_type" AS ENUM ('book', 'book_file', 'book_version', 'chapter', 'scene', 'paragraph', 'character', 'story_bible_version', 'voice_profile', 'voice_profile_version', 'audio_script', 'audio_script_chunk', 'audio_chunk', 'chapter_audio', 'audiobook', 'job', 'tenant', 'user');

-- CreateEnum
CREATE TYPE "model_role" AS ENUM ('PARSER', 'OCR', 'NORMALIZER', 'LLM', 'TTS', 'ASR', 'AUDIO_TOOL', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "model_registry_status" AS ENUM ('ACTIVE', 'DEPRECATED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "worker_kind" AS ENUM ('CPU', 'AI', 'GPU');

-- CreateEnum
CREATE TYPE "worker_status" AS ENUM ('STARTING', 'READY', 'DRAINING', 'QUARANTINED', 'STOPPED');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('USER', 'SERVICE', 'WORKER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('BOOK_CREATED', 'BOOK_DELETED', 'BOOK_RESTORED', 'BOOK_PURGED', 'UPLOAD_FINALIZED', 'FILE_QUARANTINED', 'CHARACTER_UPDATED', 'CHARACTER_MERGED', 'ALIAS_CHANGED', 'PRONUNCIATION_CHANGED', 'VOICE_VERSION_CREATED', 'VOICE_APPROVED', 'VOICE_LOCKED', 'VOICE_RETIRED', 'VOICE_ASSIGNED', 'NARRATOR_FALLBACK_ACCEPTED', 'DIRECTOR_REGENERATION_REQUESTED', 'DIRECTOR_VERSION_MIXING_ACKNOWLEDGED', 'FORCED_REGENERATION', 'TTS_REGENERATION_REQUESTED', 'ASSEMBLY_REQUESTED', 'AUDIOBOOK_PUBLISHED', 'ACCESS_URL_MINTED', 'QUOTA_CHANGED', 'JOB_CANCELLED', 'JOB_REPLAYED', 'ADMIN_CROSS_TENANT_READ', 'ROLE_CHANGED', 'SESSION_REVOKED', 'REFRESH_TOKEN_REUSE_DETECTED');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "storage_class" AS ENUM ('STANDARD', 'INFREQUENT', 'ARCHIVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "hash_algorithm" AS ENUM ('SHA256');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL,
    "plan_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "display_name" TEXT NOT NULL,
    "status" "user_status" NOT NULL,
    "roles" "principal_role"[],
    "preferences" JSONB NOT NULL,
    "locale" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credential" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_algorithm" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "mfa_enrolled" BOOLEAN NOT NULL,
    "mfa_secret_ref" TEXT,
    "failed_attempt_count" INTEGER NOT NULL,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "provider_kind" NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_provider" TEXT,
    "linked_at" TIMESTAMPTZ(6) NOT NULL,
    "last_authenticated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" TEXT,
    "user_agent_family" TEXT,
    "ip_country" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "rotated_to_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "reuse_detected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_quota" (
    "tenant_id" UUID NOT NULL,
    "concurrent_books_limit" INTEGER NOT NULL,
    "gpu_minutes_monthly_limit" INTEGER NOT NULL,
    "storage_bytes_limit" BIGINT NOT NULL,
    "books_total_limit" INTEGER NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_quota_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_usage_counter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "metric" "usage_metric" NOT NULL,
    "used_value" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_usage_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "language" TEXT NOT NULL,
    "description" TEXT,
    "series" TEXT,
    "series_index" INTEGER,
    "publication_year" INTEGER,
    "publisher" TEXT,
    "status" "book_status" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "pipeline_version" TEXT NOT NULL,
    "current_book_version_id" UUID,
    "current_audio_script_id" UUID,
    "current_audiobook_id" UUID,
    "auto_ingest" BOOLEAN NOT NULL DEFAULT false,
    "narrator_fallback_accepted" BOOLEAN NOT NULL DEFAULT false,
    "narrator_fallback_applies_to" TEXT,
    "narrator_fallback_max_line_count" INTEGER,
    "narrator_fallback_accepted_by_user_id" UUID,
    "narrator_fallback_accepted_at" TIMESTAMPTZ(6),
    "director_version_mixing_acknowledged_by_user_id" UUID,
    "director_version_mixing_acknowledged_at" TIMESTAMPTZ(6),
    "partial_ocr_acknowledged_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_counter" (
    "book_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chapter_count" INTEGER NOT NULL DEFAULT 0,
    "section_count" INTEGER NOT NULL DEFAULT 0,
    "scene_count" INTEGER NOT NULL DEFAULT 0,
    "paragraph_count" INTEGER NOT NULL DEFAULT 0,
    "character_count" INTEGER NOT NULL DEFAULT 0,
    "speaking_character_count" INTEGER NOT NULL DEFAULT 0,
    "audio_script_chunk_count" INTEGER NOT NULL DEFAULT 0,
    "audio_chunk_generated_count" INTEGER NOT NULL DEFAULT 0,
    "audio_chunk_validated_count" INTEGER NOT NULL DEFAULT 0,
    "audio_chunk_failed_count" INTEGER NOT NULL DEFAULT 0,
    "audio_chunk_invalid_count" INTEGER NOT NULL DEFAULT 0,
    "chapter_audio_count" INTEGER NOT NULL DEFAULT 0,
    "needs_review_count" INTEGER NOT NULL DEFAULT 0,
    "total_audio_duration_ms" BIGINT NOT NULL DEFAULT 0,
    "recomputed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "book_counter_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "book_file" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "source_kind" "book_source_kind" NOT NULL,
    "original_file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "sniffed_mime_type" TEXT,
    "size_bytes" BIGINT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "content_hash_algorithm" "hash_algorithm" NOT NULL,
    "status" "book_file_status" NOT NULL,
    "rejection_reason_code" TEXT,
    "page_count" INTEGER,
    "validation" JSONB,
    "upload_session_id" TEXT,
    "deduplicated_from_book_file_id" UUID,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "book_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_file_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "structure_version_label" TEXT NOT NULL,
    "supersedes_book_version_id" UUID,
    "superseded_by_book_version_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "content_hash" CHAR(64) NOT NULL,
    "raw_text_content_hash" CHAR(64) NOT NULL,
    "pipeline_version" TEXT NOT NULL,
    "parser_strategy_used" TEXT,
    "parser_model_version_id" UUID,
    "ocr_model_version_id" UUID,
    "normalizer_model_version_id" UUID,
    "parser_options" JSONB,
    "parsed_document_storage_key" TEXT,
    "parsed_document_content_hash" CHAR(64),
    "parsed_document_object_verified_at" TIMESTAMPTZ(6),
    "ocr_report_storage_key" TEXT,
    "ocr_report_content_hash" CHAR(64),
    "ocr_report_object_verified_at" TIMESTAMPTZ(6),
    "canonical_text_manifest_storage_key" TEXT,
    "canonical_text_manifest_content_hash" CHAR(64),
    "canonical_text_manifest_object_verified_at" TIMESTAMPTZ(6),
    "storage_bucket" TEXT NOT NULL,
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "status" "book_version_status" NOT NULL,
    "text_qc_outcome" "text_qc_outcome",
    "text_qc" JSONB,
    "pages_total" INTEGER,
    "pages_ok" INTEGER,
    "pages_needs_review" INTEGER,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "book_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parsed_page" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "page_number" INTEGER NOT NULL,
    "extraction_method" "extraction_method" NOT NULL,
    "ocr_model_version_id" UUID,
    "confidence" REAL,
    "char_count" INTEGER NOT NULL,
    "status" "parsed_page_status" NOT NULL,
    "failure_reason_code" TEXT,
    "block_confidence" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "parsed_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "spine_start" INTEGER NOT NULL,
    "spine_end" INTEGER NOT NULL,
    "title" TEXT,
    "matter_type" "matter_type" NOT NULL,
    "canonical_text_storage_key" TEXT,
    "canonical_text_content_hash" CHAR(64),
    "char_count" INTEGER NOT NULL,
    "text_qc_outcome" "text_qc_outcome",
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "spine_start" INTEGER NOT NULL,
    "spine_end" INTEGER NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "section_id" UUID,
    "order_index" INTEGER NOT NULL,
    "start_paragraph_id" UUID NOT NULL,
    "end_paragraph_id" UUID NOT NULL,
    "paragraph_count" INTEGER NOT NULL,
    "spine_start" INTEGER NOT NULL,
    "spine_end" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paragraph" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "section_id" UUID,
    "scene_id" UUID,
    "order_index" INTEGER NOT NULL,
    "spine_position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "char_count" INTEGER NOT NULL,
    "scripted_at" TIMESTAMPTZ(6),
    "source_page_number" INTEGER,
    "source_page_end_number" INTEGER,
    "source_locator" JSONB,
    "raw_text_content_hash" CHAR(64) NOT NULL,
    "extraction_method" "extraction_method" NOT NULL,
    "extraction_confidence" REAL,
    "parsed_page_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "character_status" NOT NULL,
    "is_sentinel" BOOLEAN NOT NULL DEFAULT false,
    "sentinel_kind" "character_sentinel",
    "importance_rank" INTEGER,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "speaking" BOOLEAN NOT NULL DEFAULT false,
    "narrator_capable" BOOLEAN NOT NULL DEFAULT false,
    "pronoun_sets" JSONB,
    "speech_traits" JSONB,
    "first_appearance_book_version_id" UUID,
    "first_appearance_chapter_id" UUID,
    "first_appearance_paragraph_id" UUID,
    "last_appearance_book_version_id" UUID,
    "last_appearance_chapter_id" UUID,
    "last_appearance_paragraph_id" UUID,
    "detection_source" "detection_source",
    "detected_by_model_version_id" UUID,
    "detection_confidence" REAL,
    "evidence_paragraph_ids" UUID[],
    "merged_into_character_id" UUID,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_alias" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "surface_form" TEXT NOT NULL,
    "surface_form_normalized" TEXT NOT NULL,
    "alias_type" "character_alias_type" NOT NULL,
    "scope_kind" "alias_scope" NOT NULL,
    "scope_chapter_id" UUID,
    "scope_speaker_character_id" UUID,
    "valid_from_spine" INTEGER,
    "valid_to_spine" INTEGER,
    "source" "extraction_source" NOT NULL,
    "detected_by_model_version_id" UUID,
    "confidence" REAL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_merge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "operation" "merge_operation" NOT NULL,
    "losing_character_id" UUID NOT NULL,
    "winning_character_id" UUID NOT NULL,
    "voice_conflict_resolution" JSONB,
    "rebind_scope" TEXT NOT NULL,
    "aliases_moved_count" INTEGER NOT NULL DEFAULT 0,
    "draft_chunks_rebound_count" INTEGER NOT NULL DEFAULT 0,
    "generated_chunks_reversioned_count" INTEGER NOT NULL DEFAULT 0,
    "chapters_affected" UUID[],
    "job_id" UUID,
    "performed_by_user_id" UUID NOT NULL,
    "reversed_at" TIMESTAMPTZ(6),
    "reversed_by_merge_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_merge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_relationship" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "source_character_id" UUID NOT NULL,
    "target_character_id" UUID NOT NULL,
    "relationship_type" "relationship_type" NOT NULL,
    "label" TEXT,
    "directional" BOOLEAN NOT NULL DEFAULT true,
    "confidence" REAL NOT NULL,
    "valid_from_spine" INTEGER,
    "valid_to_spine" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_bible" (
    "book_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "story_bible_status" NOT NULL,
    "current_version_id" UUID,
    "current_version_number" INTEGER,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "stale_reasons" "story_bible_stale_reason"[],
    "spine_position_analyzed" INTEGER,
    "chapters_analyzed" INTEGER NOT NULL DEFAULT 0,
    "chapters_total" INTEGER NOT NULL DEFAULT 0,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "last_updated_at" TIMESTAMPTZ(6),
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "story_bible_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "story_bible_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_story_bible_version_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "build_mode" "story_bible_build_mode" NOT NULL,
    "spine_position_covered" INTEGER,
    "chapters_covered" INTEGER NOT NULL DEFAULT 0,
    "built_by_model_version_id" UUID NOT NULL,
    "source_content_hash" CHAR(64) NOT NULL,
    "facts_content_hash" CHAR(64) NOT NULL,
    "pov_type" "pov_type",
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "degraded_layers" "context_layer"[],
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "story_bible_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_semantics" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "scene_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "summary" TEXT,
    "location_id" UUID,
    "in_story_time" TEXT,
    "mood" TEXT,
    "tension" REAL,
    "pov_character_id" UUID,
    "narrative_state_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scene_semantics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_participant" (
    "scene_semantics_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "speaking_line_count" INTEGER NOT NULL DEFAULT 0,
    "first_spine_position" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scene_participant_pkey" PRIMARY KEY ("scene_semantics_id","character_id")
);

-- CreateTable
CREATE TABLE "narrative_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "scene_id" UUID,
    "spine_position" INTEGER NOT NULL,
    "checkpoint_kind" "checkpoint_kind" NOT NULL,
    "pov_character_id" UUID,
    "pov_type" "pov_type",
    "present_character_ids" UUID[],
    "previous_speaker_character_id" UUID,
    "emotional_register" TEXT,
    "location_id" UUID,
    "timeline_position" TEXT,
    "unresolved_thread_ids" UUID[],
    "open_state" JSONB,
    "extracted_by_model_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narrative_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_location" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_location_id" UUID,
    "atmosphere" JSONB,
    "location_kind" TEXT,
    "first_spine_position" INTEGER,
    "last_spine_position" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_timeline_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "ordinal" INTEGER NOT NULL,
    "in_story_time_marker" TEXT,
    "span_kind" "span_kind" NOT NULL,
    "scene_id" UUID,
    "first_spine_position" INTEGER,
    "last_spine_position" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_timeline_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_object" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "significance" TEXT,
    "custody_character_id" UUID,
    "attributes" JSONB,
    "first_spine_position" INTEGER,
    "last_spine_position" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_faction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "allegiance_faction_id" UUID,
    "attributes" JSONB,
    "first_spine_position" INTEGER,
    "last_spine_position" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_faction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_thread" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "kind" "narrative_thread_kind" NOT NULL,
    "summary" TEXT,
    "known_to_character_ids" UUID[],
    "opened_spine_position" INTEGER NOT NULL,
    "resolved_spine_position" INTEGER,
    "status" "narrative_thread_status" NOT NULL,
    "first_spine_position" INTEGER,
    "last_spine_position" INTEGER,
    "evidence_paragraph_ids" UUID[],
    "evidence_scene_id" UUID,
    "extracted_by_model_version_id" UUID NOT NULL,
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_summary" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "level" "summary_level" NOT NULL,
    "target_id" UUID NOT NULL,
    "target_content_hash" CHAR(64) NOT NULL,
    "body_preview" TEXT NOT NULL,
    "body_storage_key" TEXT,
    "token_count" INTEGER,
    "generated_by_model_version_id" UUID NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narrative_embedding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "source_kind" "embedding_source_kind" NOT NULL,
    "source_id" UUID NOT NULL,
    "source_content_hash" CHAR(64) NOT NULL,
    "embedding" vector(1536),
    "embedding_model_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "narrative_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pronunciation_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "surface_form" TEXT NOT NULL,
    "surface_form_normalized" TEXT NOT NULL,
    "lexicon_key" TEXT,
    "ipa" TEXT,
    "applies_to" "pronunciation_scope" NOT NULL,
    "applies_to_character_id" UUID,
    "applies_to_chapter_id" UUID,
    "notes" TEXT,
    "source" "extraction_source" NOT NULL,
    "created_by_user_id" UUID,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pronunciation_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_profile" (
    "id" UUID NOT NULL,
    "scope" "voice_profile_scope" NOT NULL,
    "tenant_id" UUID,
    "book_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active_version_id" UUID,
    "active_version_number" INTEGER,
    "version_count" INTEGER NOT NULL DEFAULT 0,
    "lock_state" "voice_lock_state" NOT NULL DEFAULT 'UNLOCKED',
    "intended_character_ids" UUID[],
    "snapshotted_from_system_profile_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "voice_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_profile_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "voice_profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_version_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "tts_provider_id" TEXT NOT NULL,
    "tts_model_id" TEXT NOT NULL,
    "tts_model_version_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "supported_languages" TEXT[],
    "base_generation_params" JSONB NOT NULL,
    "base_generation_params_hash" CHAR(64) NOT NULL,
    "default_pitch" REAL,
    "default_volume" REAL,
    "default_pacing" REAL,
    "reference_audio_storage_key" TEXT,
    "reference_audio_content_hash" CHAR(64),
    "reference_audio_duration_ms" INTEGER,
    "reference_audio_verified_at" TIMESTAMPTZ(6),
    "embedding_storage_key" TEXT,
    "embedding_content_hash" CHAR(64),
    "embedding_extractor_model_version_id" UUID,
    "embedding_extracted_at" TIMESTAMPTZ(6),
    "emotion_capability_map" JSONB,
    "approval_state" "voice_approval_state" NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "lock_state" "voice_lock_state" NOT NULL DEFAULT 'UNLOCKED',
    "locked_at" TIMESTAMPTZ(6),
    "locked_reason" "voice_lock_reason",
    "retired_at" TIMESTAMPTZ(6),
    "consent_attested" BOOLEAN NOT NULL,
    "consent_subject" "consent_subject" NOT NULL,
    "consent_attestation_text" TEXT,
    "consent_attested_by_user_id" UUID NOT NULL,
    "consent_attested_at" TIMESTAMPTZ(6) NOT NULL,
    "reference_provenance" "reference_provenance" NOT NULL,
    "derived_from_version_id" UUID,
    "identity_fingerprint" CHAR(64) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_profile_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_assignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "voice_profile_id" UUID NOT NULL,
    "voice_profile_version_id" UUID NOT NULL,
    "role" "voice_assignment_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "deactivated_at" TIMESTAMPTZ(6),
    "superseded_by_assignment_id" UUID,
    "snapshotted_from_system_profile_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_preview" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "voice_profile_id" UUID NOT NULL,
    "voice_profile_version_id" UUID NOT NULL,
    "book_id" UUID,
    "character_id" UUID,
    "source_paragraph_id" UUID,
    "text_excerpt" TEXT NOT NULL,
    "emotion" "emotion" NOT NULL,
    "capability_gap" JSONB,
    "status" "voice_preview_status" NOT NULL,
    "duration_ms" INTEGER,
    "sample_rate" INTEGER,
    "tts_model_version_id" UUID NOT NULL,
    "generation_params_hash" CHAR(64) NOT NULL,
    "seed" BIGINT,
    "job_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "storage_key" TEXT,
    "storage_bucket" TEXT,
    "content_hash" CHAR(64),
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_preview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_script" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "scope" "audio_script_scope" NOT NULL,
    "scope_chapter_id" UUID,
    "version" INTEGER NOT NULL,
    "supersedes_audio_script_id" UUID,
    "superseded_by_audio_script_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "schema_version" TEXT NOT NULL,
    "director_version" TEXT NOT NULL,
    "director_model_version_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "source_content_hash" CHAR(64) NOT NULL,
    "structure_version_label" TEXT NOT NULL,
    "context_bundle_hash" CHAR(64),
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "total_characters" INTEGER NOT NULL DEFAULT 0,
    "estimated_audio_ms" BIGINT NOT NULL DEFAULT 0,
    "state" "audio_script_state" NOT NULL,
    "validation" JSONB,
    "coverage_verified" BOOLEAN NOT NULL DEFAULT false,
    "coverage_gap_count" INTEGER NOT NULL DEFAULT 0,
    "coverage_overlap_count" INTEGER NOT NULL DEFAULT 0,
    "unknown_speaker_rate" REAL,
    "fallback_applied_count" INTEGER NOT NULL DEFAULT 0,
    "low_confidence_chunk_count" INTEGER NOT NULL DEFAULT 0,
    "job_id" UUID,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_script_chunk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "audio_script_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "section_id" UUID,
    "scene_id" UUID,
    "sequence_index" INTEGER NOT NULL,
    "chapter_sequence_index" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_chunk_id" UUID,
    "superseded_by_chunk_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "source_content_hash" CHAR(64) NOT NULL,
    "schema_version" TEXT NOT NULL,
    "director_version" TEXT NOT NULL,
    "director_model_version_id" UUID NOT NULL,
    "context_bundle_hash" CHAR(64) NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "spoken_text" TEXT,
    "language" TEXT NOT NULL,
    "script" TEXT,
    "spoken_text_substitutions" JSONB,
    "speaker_type" "speaker_type" NOT NULL,
    "character_id" UUID,
    "is_dialogue" BOOLEAN NOT NULL DEFAULT false,
    "delivery_mode" "delivery_mode" NOT NULL,
    "emotion" "emotion" NOT NULL,
    "emotion_intensity" REAL NOT NULL,
    "pacing" REAL NOT NULL,
    "pitch" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "pauses" JSONB,
    "emphasis" JSONB,
    "pronunciation_hints" JSONB,
    "non_verbal" JSONB,
    "voice_profile_id" UUID,
    "voice_profile_version_id" UUID,
    "tts_provider_id" TEXT,
    "generation_params" JSONB,
    "generation_params_hash" CHAR(64),
    "seed" BIGINT,
    "target_sample_rate" INTEGER,
    "target_channels" INTEGER,
    "confidence" REAL NOT NULL,
    "decision_confidence" JSONB,
    "review_flags" "review_flag"[],
    "fallback_applied" BOOLEAN NOT NULL DEFAULT false,
    "fallback_reason" TEXT,
    "capability_gaps" JSONB,
    "continuity" JSONB,
    "origin" "chunk_origin" NOT NULL DEFAULT 'AUTO_GENERATED',
    "director_original" JSONB,
    "override" JSONB,
    "state" "audio_script_chunk_state" NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "current_audio_chunk_id" UUID,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_script_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_script_chunk_source" (
    "audio_script_chunk_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "paragraph_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "paragraph_char_start" INTEGER NOT NULL,
    "paragraph_char_end" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_script_chunk_source_pkey" PRIMARY KEY ("audio_script_chunk_id","order_index")
);

-- CreateTable
CREATE TABLE "tts_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "audio_script_chunk_id" UUID NOT NULL,
    "audio_script_chunk_version" INTEGER NOT NULL,
    "processing_job_id" UUID,
    "tts_provider_id" TEXT NOT NULL,
    "tts_model_version_id" UUID NOT NULL,
    "voice_profile_id" UUID NOT NULL,
    "voice_profile_version_id" UUID NOT NULL,
    "generation_params" JSONB NOT NULL,
    "generation_params_hash" CHAR(64) NOT NULL,
    "seed" BIGINT,
    "target_sample_rate" INTEGER NOT NULL,
    "target_channels" INTEGER NOT NULL,
    "status" "tts_job_status" NOT NULL,
    "dedupe_key" CHAR(64) NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "force_token" TEXT,
    "audio_chunk_id" UUID,
    "duration_ms" INTEGER,
    "generation_time_ms" INTEGER,
    "capability_gaps" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tts_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_chunk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "audio_script_chunk_id" UUID NOT NULL,
    "tts_job_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "scene_id" UUID,
    "character_id" UUID,
    "sequence_index" INTEGER NOT NULL,
    "generation_version" INTEGER NOT NULL,
    "supersedes_audio_chunk_id" UUID,
    "superseded_by_audio_chunk_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "status" "audio_chunk_status" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "source_content_hash" CHAR(64) NOT NULL,
    "audio_script_ir_schema_version" TEXT NOT NULL,
    "director_version" TEXT NOT NULL,
    "director_model_version_id" UUID NOT NULL,
    "voice_profile_id" UUID NOT NULL,
    "voice_profile_version_id" UUID NOT NULL,
    "tts_provider_id" TEXT NOT NULL,
    "tts_model_version_id" UUID NOT NULL,
    "generation_params_hash" CHAR(64) NOT NULL,
    "seed" BIGINT,
    "pipeline_version" TEXT NOT NULL,
    "book_version_id" UUID NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "format" "audio_format" NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "sample_rate" INTEGER NOT NULL,
    "channels" INTEGER NOT NULL,
    "peak_dbfs" REAL,
    "true_peak_dbtp" REAL,
    "integrated_lufs" REAL,
    "rms_dbfs" REAL,
    "validation_status" "validation_status" NOT NULL DEFAULT 'PENDING',
    "validation" JSONB,
    "asr_sampled" BOOLEAN NOT NULL DEFAULT false,
    "asr_wer" REAL,
    "asr_model_version_id" UUID,
    "asr_outcome" TEXT,
    "capability_gaps" JSONB,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "error_code" TEXT,
    "error_class" TEXT,
    "error_message" TEXT,
    "failing_check" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audio_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter_audio" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_chapter_audio_id" UUID,
    "superseded_by_chapter_audio_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "is_preview_build" BOOLEAN NOT NULL DEFAULT false,
    "status" "chapter_audio_status" NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "chunk_manifest_hash" CHAR(64) NOT NULL,
    "format" "audio_format" NOT NULL,
    "integrated_lufs" REAL,
    "true_peak_dbtp" REAL,
    "validation" JSONB,
    "voice_consistency_verified" BOOLEAN NOT NULL DEFAULT false,
    "voice_consistency" JSONB,
    "director_version" TEXT NOT NULL,
    "pipeline_version" TEXT NOT NULL,
    "audio_tool_model_version_id" UUID NOT NULL,
    "assembly_version" TEXT NOT NULL,
    "job_id" UUID,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chapter_audio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter_audio_member" (
    "chapter_audio_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "audio_chunk_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "lead_silence_trimmed_ms" INTEGER NOT NULL DEFAULT 0,
    "pause_applied_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chapter_audio_member_pkey" PRIMARY KEY ("chapter_audio_id","order_index")
);

-- CreateTable
CREATE TABLE "audiobook" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "book_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_audiobook_id" UUID,
    "superseded_by_audiobook_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(6),
    "is_preview_build" BOOLEAN NOT NULL DEFAULT false,
    "status" "audiobook_status" NOT NULL,
    "container_format" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "chapter_count" INTEGER NOT NULL,
    "metadata_title" TEXT NOT NULL,
    "metadata_author" TEXT,
    "metadata_narrator_credit" TEXT,
    "ai_narration_disclosed" BOOLEAN NOT NULL DEFAULT true,
    "metadata_series" TEXT,
    "metadata_series_index" INTEGER,
    "metadata_publisher" TEXT,
    "metadata_language" TEXT NOT NULL,
    "metadata_publication_year" INTEGER,
    "metadata_description" TEXT,
    "audiobook_cover_id" UUID,
    "book_wer" REAL,
    "chunks_flagged" INTEGER NOT NULL DEFAULT 0,
    "asr_coverage" REAL,
    "pipeline_version" TEXT NOT NULL,
    "director_version" TEXT NOT NULL,
    "tts_model_version_ids" UUID[],
    "audio_tool_model_version_id" UUID NOT NULL,
    "source_content_hash" CHAR(64) NOT NULL,
    "story_bible_version_id" UUID NOT NULL,
    "chapter_manifest_hash" CHAR(64) NOT NULL,
    "job_id" UUID,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audiobook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audiobook_chapter" (
    "audiobook_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "chapter_id" UUID NOT NULL,
    "chapter_audio_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "title" TEXT,
    "start_ms" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audiobook_chapter_pkey" PRIMARY KEY ("audiobook_id","order_index")
);

-- CreateTable
CREATE TABLE "audiobook_rendition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "audiobook_id" UUID NOT NULL,
    "format" "delivery_format" NOT NULL,
    "chapter_id" UUID,
    "bitrate_kbps" INTEGER NOT NULL,
    "sample_rate" INTEGER NOT NULL,
    "channels" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "audio_tool_model_version_id" UUID NOT NULL,
    "encode_params" JSONB,
    "status" TEXT NOT NULL,
    "job_id" UUID,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audiobook_rendition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audiobook_cover" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "audiobook_id" UUID NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "exif_stripped_at" TIMESTAMPTZ(6),
    "uploaded_by_user_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "content_hash_algorithm" "hash_algorithm" NOT NULL,
    "size_bytes" BIGINT,
    "object_verified_at" TIMESTAMPTZ(6),
    "storage_class" "storage_class" NOT NULL DEFAULT 'STANDARD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audiobook_cover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_registry" (
    "id" UUID NOT NULL,
    "role" "model_role" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "licence_note" TEXT,
    "status" "model_registry_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "model_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_version" (
    "id" UUID NOT NULL,
    "model_registry_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "params_fingerprint" CHAR(64) NOT NULL,
    "config" JSONB,
    "weights_storage_key" TEXT,
    "weights_content_hash" CHAR(64),
    "released_at" TIMESTAMPTZ(6) NOT NULL,
    "deprecated_at" TIMESTAMPTZ(6),
    "quarantined_at" TIMESTAMPTZ(6),
    "quarantine_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "model_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID,
    "type" "job_type" NOT NULL,
    "queue" "job_queue" NOT NULL,
    "priority" "job_priority" NOT NULL,
    "related_resource_type" "resource_type" NOT NULL,
    "related_resource_id" UUID NOT NULL,
    "scope" JSONB,
    "parent_job_id" UUID,
    "child_job_count" INTEGER NOT NULL DEFAULT 0,
    "child_succeeded_count" INTEGER NOT NULL DEFAULT 0,
    "child_failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" "job_status" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_reason" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "progress" REAL NOT NULL DEFAULT 0,
    "progress_stage" TEXT,
    "completed_units" INTEGER NOT NULL DEFAULT 0,
    "total_units" INTEGER,
    "lease_worker_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "idempotency_fingerprint" CHAR(64) NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "forced_by_user_id" UUID,
    "error_code" TEXT,
    "error_class" TEXT,
    "error_message" TEXT,
    "error_retryable" BOOLEAN,
    "error_terminal" BOOLEAN,
    "result_resource_type" "resource_type",
    "result_resource_id" UUID,
    "result_version" INTEGER,
    "cancellation_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancellation_requested_at" TIMESTAMPTZ(6),
    "cancellation_requested_by_user_id" UUID,
    "cancellation_effective_at" TIMESTAMPTZ(6),
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "traceparent" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "processing_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_attempt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "book_id" UUID,
    "attempt_number" INTEGER NOT NULL,
    "status" "attempt_status" NOT NULL,
    "worker_id" UUID NOT NULL,
    "worker_host_ref" TEXT,
    "lease_fence" BIGINT NOT NULL,
    "model_versions" JSONB,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_class" TEXT,
    "error_message" TEXT,
    "error_detail" JSONB,
    "diagnostic_storage_key" TEXT,
    "resource_usage" JSONB,
    "output_resource_type" "resource_type",
    "output_resource_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_dependency" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "depends_on_job_id" UUID,
    "kind" "dependency_kind" NOT NULL,
    "gate_key" TEXT,
    "satisfied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path_template" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_body_hash" CHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL,
    "response_status_code" INTEGER,
    "response_body" JSONB,
    "response_location" TEXT,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker" (
    "id" UUID NOT NULL,
    "kind" "worker_kind" NOT NULL,
    "queues" "job_queue"[],
    "capabilities" JSONB NOT NULL,
    "loaded_model_version_ids" UUID[],
    "status" "worker_status" NOT NULL,
    "quarantine_reason" TEXT,
    "quarantined_at" TIMESTAMPTZ(6),
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "service_version" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID,
    "actor_kind" "actor_kind" NOT NULL,
    "actor_user_id" UUID,
    "actor_service" TEXT,
    "action" "audit_action" NOT NULL,
    "resource_type" "resource_type" NOT NULL,
    "resource_id" UUID,
    "book_id" UUID,
    "request_id" TEXT,
    "trace_id" TEXT,
    "correlation_id" TEXT,
    "outcome" "audit_outcome" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- NOTE: the primary key is widened from (id) to (id, occurred_at) because
    -- PostgreSQL requires the partition key to be part of every unique/primary
    -- key constraint on a partitioned table. `id` is still generated
    -- application-side as a UUIDv7 and remains globally unique in practice;
    -- what changes is that PostgreSQL itself can no longer prove uniqueness on
    -- `id` alone. See database-schema.md §17.1 and prisma/README.md for the
    -- tradeoff this forces.
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID,
    "job_id" UUID,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT NOT NULL,
    "traceparent" TEXT,
    "producer" TEXT NOT NULL,
    "producer_version" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "published_at" TIMESTAMPTZ(6),
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_inbox" (
    "consumer_name" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,
    "outcome" "inbox_outcome" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_inbox_pkey" PRIMARY KEY ("consumer_name","event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_credential_user_id_key" ON "user_credential"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_provider_issuer_subject_key" ON "user_identity"("provider", "issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_usage_counter_tenant_id_period_start_metric_key" ON "tenant_usage_counter"("tenant_id", "period_start", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "book_id_tenant_id_key" ON "book"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "book_counter_book_id_tenant_id_key" ON "book_counter"("book_id", "tenant_id");

-- CreateIndex
CREATE INDEX "book_file_book_id_created_at_idx" ON "book_file"("book_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "book_version_book_file_id_idx" ON "book_version"("book_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "book_version_book_id_version_key" ON "book_version"("book_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "book_version_id_book_id_key" ON "book_version"("id", "book_id");

-- CreateIndex
CREATE UNIQUE INDEX "parsed_page_book_version_id_page_number_key" ON "parsed_page"("book_version_id", "page_number");

-- CreateIndex
CREATE INDEX "chapter_book_version_id_matter_type_idx" ON "chapter"("book_version_id", "matter_type");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_id_book_id_key" ON "chapter"("id", "book_id");

-- CreateIndex
CREATE INDEX "paragraph_chapter_id_order_index_idx" ON "paragraph"("chapter_id", "order_index");

-- CreateIndex
CREATE INDEX "paragraph_book_version_id_content_hash_idx" ON "paragraph"("book_version_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "paragraph_book_version_id_spine_position_key" ON "paragraph"("book_version_id", "spine_position");

-- CreateIndex
CREATE UNIQUE INDEX "paragraph_id_chapter_id_key" ON "paragraph"("id", "chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "paragraph_id_book_id_key" ON "paragraph"("id", "book_id");

-- CreateIndex
CREATE INDEX "character_book_id_importance_rank_idx" ON "character"("book_id", "importance_rank");

-- CreateIndex
CREATE UNIQUE INDEX "character_id_book_id_key" ON "character"("id", "book_id");

-- CreateIndex
CREATE INDEX "character_alias_character_id_idx" ON "character_alias"("character_id");

-- CreateIndex
CREATE INDEX "character_alias_book_id_surface_form_normalized_idx" ON "character_alias"("book_id", "surface_form_normalized");

-- CreateIndex
CREATE INDEX "character_merge_book_id_created_at_idx" ON "character_merge"("book_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "character_merge_losing_character_id_idx" ON "character_merge"("losing_character_id");

-- CreateIndex
CREATE INDEX "character_relationship_book_id_source_character_id_idx" ON "character_relationship"("book_id", "source_character_id");

-- CreateIndex
CREATE INDEX "character_relationship_book_id_target_character_id_idx" ON "character_relationship"("book_id", "target_character_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_relationship_story_bible_version_id_source_charac_key" ON "character_relationship"("story_bible_version_id", "source_character_id", "target_character_id", "relationship_type", "valid_from_spine");

-- CreateIndex
CREATE UNIQUE INDEX "story_bible_book_id_tenant_id_key" ON "story_bible"("book_id", "tenant_id");

-- CreateIndex
CREATE INDEX "story_bible_version_book_version_id_idx" ON "story_bible_version"("book_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "story_bible_version_book_id_version_key" ON "story_bible_version"("book_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "story_bible_version_id_book_id_key" ON "story_bible_version"("id", "book_id");

-- CreateIndex
CREATE INDEX "scene_semantics_story_bible_version_id_book_id_idx" ON "scene_semantics"("story_bible_version_id", "book_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_semantics_scene_id_story_bible_version_id_key" ON "scene_semantics"("scene_id", "story_bible_version_id");

-- CreateIndex
CREATE INDEX "scene_participant_character_id_idx" ON "scene_participant"("character_id");

-- CreateIndex
CREATE INDEX "narrative_state_book_id_chapter_id_spine_position_idx" ON "narrative_state"("book_id", "chapter_id", "spine_position");

-- CreateIndex
CREATE UNIQUE INDEX "narrative_state_book_id_story_bible_version_id_spine_positi_key" ON "narrative_state"("book_id", "story_bible_version_id", "spine_position");

-- CreateIndex
CREATE INDEX "narrative_location_parent_location_id_idx" ON "narrative_location"("parent_location_id");

-- CreateIndex
CREATE INDEX "narrative_timeline_event_story_bible_version_id_first_spine_idx" ON "narrative_timeline_event"("story_bible_version_id", "first_spine_position");

-- CreateIndex
CREATE UNIQUE INDEX "narrative_timeline_event_story_bible_version_id_ordinal_key" ON "narrative_timeline_event"("story_bible_version_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "narrative_summary_story_bible_version_id_level_target_id_key" ON "narrative_summary"("story_bible_version_id", "level", "target_id");

-- CreateIndex
CREATE INDEX "narrative_embedding_book_id_story_bible_version_id_idx" ON "narrative_embedding"("book_id", "story_bible_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "narrative_embedding_story_bible_version_id_source_kind_sour_key" ON "narrative_embedding"("story_bible_version_id", "source_kind", "source_id", "embedding_model_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "pronunciation_entry_book_id_surface_form_normalized_applies_key" ON "pronunciation_entry"("book_id", "surface_form_normalized", "applies_to");

-- CreateIndex
CREATE UNIQUE INDEX "pronunciation_entry_book_id_lexicon_key_key" ON "pronunciation_entry"("book_id", "lexicon_key");

-- CreateIndex
CREATE INDEX "voice_profile_version_voice_profile_id_approval_state_idx" ON "voice_profile_version"("voice_profile_id", "approval_state");

-- CreateIndex
CREATE INDEX "voice_profile_version_tts_model_version_id_idx" ON "voice_profile_version"("tts_model_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_profile_version_voice_profile_id_version_key" ON "voice_profile_version"("voice_profile_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "voice_profile_version_voice_profile_id_identity_fingerprint_key" ON "voice_profile_version"("voice_profile_id", "identity_fingerprint");

-- CreateIndex
CREATE INDEX "voice_assignment_voice_profile_version_id_idx" ON "voice_assignment"("voice_profile_version_id");

-- CreateIndex
CREATE INDEX "voice_preview_voice_profile_version_id_created_at_idx" ON "voice_preview"("voice_profile_version_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audio_script_book_version_id_idx" ON "audio_script"("book_version_id");

-- CreateIndex
CREATE INDEX "audio_script_story_bible_version_id_idx" ON "audio_script"("story_bible_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_script_book_id_version_key" ON "audio_script"("book_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "audio_script_id_book_id_key" ON "audio_script"("id", "book_id");

-- CreateIndex
CREATE INDEX "audio_script_chunk_source_content_hash_idx" ON "audio_script_chunk"("source_content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "audio_script_chunk_book_id_id_key" ON "audio_script_chunk"("book_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_script_chunk_id_character_id_key" ON "audio_script_chunk"("id", "character_id");

-- CreateIndex
CREATE INDEX "audio_script_chunk_source_paragraph_id_idx" ON "audio_script_chunk_source"("paragraph_id");

-- CreateIndex
CREATE INDEX "audio_script_chunk_source_book_id_paragraph_id_idx" ON "audio_script_chunk_source"("book_id", "paragraph_id");

-- CreateIndex
CREATE UNIQUE INDEX "tts_job_dedupe_key_key" ON "tts_job"("dedupe_key");

-- CreateIndex
CREATE INDEX "tts_job_audio_script_chunk_id_created_at_idx" ON "tts_job"("audio_script_chunk_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tts_job_processing_job_id_idx" ON "tts_job"("processing_job_id");

-- CreateIndex
CREATE INDEX "audio_chunk_tts_model_version_id_idx" ON "audio_chunk"("tts_model_version_id");

-- CreateIndex
CREATE INDEX "audio_chunk_tts_job_id_idx" ON "audio_chunk"("tts_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_chunk_book_id_id_key" ON "audio_chunk"("book_id", "id");

-- CreateIndex
CREATE INDEX "chapter_audio_book_id_status_idx" ON "chapter_audio"("book_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_audio_chapter_id_version_key" ON "chapter_audio"("chapter_id", "version");

-- CreateIndex
CREATE INDEX "chapter_audio_member_audio_chunk_id_idx" ON "chapter_audio_member"("audio_chunk_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_audio_member_chapter_audio_id_audio_chunk_id_key" ON "chapter_audio_member"("chapter_audio_id", "audio_chunk_id");

-- CreateIndex
CREATE INDEX "audiobook_book_id_created_at_idx" ON "audiobook"("book_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audiobook_book_version_id_idx" ON "audiobook"("book_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "audiobook_book_id_version_key" ON "audiobook"("book_id", "version");

-- CreateIndex
CREATE INDEX "audiobook_chapter_chapter_audio_id_idx" ON "audiobook_chapter"("chapter_audio_id");

-- CreateIndex
CREATE UNIQUE INDEX "audiobook_chapter_audiobook_id_chapter_id_key" ON "audiobook_chapter"("audiobook_id", "chapter_id");

-- CreateIndex
CREATE INDEX "audiobook_rendition_audiobook_id_idx" ON "audiobook_rendition"("audiobook_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_registry_role_provider_id_model_id_key" ON "model_registry"("role", "provider_id", "model_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_version_model_registry_id_version_params_fingerprint_key" ON "model_version"("model_registry_id", "version", "params_fingerprint");

-- CreateIndex
CREATE INDEX "processing_job_book_id_created_at_idx" ON "processing_job"("book_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "processing_job_tenant_id_status_created_at_idx" ON "processing_job"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "processing_job_related_resource_type_related_resource_id_idx" ON "processing_job"("related_resource_type", "related_resource_id");

-- CreateIndex
CREATE INDEX "processing_attempt_job_id_started_at_idx" ON "processing_attempt"("job_id", "started_at");

-- CreateIndex
CREATE INDEX "processing_attempt_worker_id_started_at_idx" ON "processing_attempt"("worker_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "processing_attempt_job_id_attempt_number_key" ON "processing_attempt"("job_id", "attempt_number");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_key_job_id_idx" ON "idempotency_key"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_tenant_id_principal_id_method_path_template_key" ON "idempotency_key"("tenant_id", "principal_id", "method", "path_template", "key");

-- CreateIndex
CREATE INDEX "worker_status_last_heartbeat_at_idx" ON "worker"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_resource_type_resource_id_occurred_at_idx" ON "audit_log"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_occurred_at_idx" ON "audit_log"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_message_event_id_key" ON "outbox_message"("event_id");

-- CreateIndex
CREATE INDEX "outbox_message_aggregate_type_aggregate_id_created_at_idx" ON "outbox_message"("aggregate_type", "aggregate_id", "created_at");

-- CreateIndex
CREATE INDEX "event_inbox_processed_at_idx" ON "event_inbox"("processed_at");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credential" ADD CONSTRAINT "user_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_rotated_to_id_fkey" FOREIGN KEY ("rotated_to_id") REFERENCES "refresh_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_quota" ADD CONSTRAINT "tenant_quota_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_quota" ADD CONSTRAINT "tenant_quota_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage_counter" ADD CONSTRAINT "tenant_usage_counter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_narrator_fallback_accepted_by_user_id_fkey" FOREIGN KEY ("narrator_fallback_accepted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_director_version_mixing_acknowledged_by_user_id_fkey" FOREIGN KEY ("director_version_mixing_acknowledged_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_current_book_version_id_fkey" FOREIGN KEY ("current_book_version_id") REFERENCES "book_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_current_audio_script_id_fkey" FOREIGN KEY ("current_audio_script_id") REFERENCES "audio_script"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_current_audiobook_id_fkey" FOREIGN KEY ("current_audiobook_id") REFERENCES "audiobook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_counter" ADD CONSTRAINT "book_counter_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_file" ADD CONSTRAINT "book_file_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_file" ADD CONSTRAINT "book_file_deduplicated_from_book_file_id_fkey" FOREIGN KEY ("deduplicated_from_book_file_id") REFERENCES "book_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_book_file_id_fkey" FOREIGN KEY ("book_file_id") REFERENCES "book_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_supersedes_book_version_id_fkey" FOREIGN KEY ("supersedes_book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_superseded_by_book_version_id_fkey" FOREIGN KEY ("superseded_by_book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_parser_model_version_id_fkey" FOREIGN KEY ("parser_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_ocr_model_version_id_fkey" FOREIGN KEY ("ocr_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_normalizer_model_version_id_fkey" FOREIGN KEY ("normalizer_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parsed_page" ADD CONSTRAINT "parsed_page_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parsed_page" ADD CONSTRAINT "parsed_page_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parsed_page" ADD CONSTRAINT "parsed_page_ocr_model_version_id_fkey" FOREIGN KEY ("ocr_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_start_paragraph_id_chapter_id_fkey" FOREIGN KEY ("start_paragraph_id", "chapter_id") REFERENCES "paragraph"("id", "chapter_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_end_paragraph_id_chapter_id_fkey" FOREIGN KEY ("end_paragraph_id", "chapter_id") REFERENCES "paragraph"("id", "chapter_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_parsed_page_id_fkey" FOREIGN KEY ("parsed_page_id") REFERENCES "parsed_page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_first_appearance_book_version_id_fkey" FOREIGN KEY ("first_appearance_book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_first_appearance_chapter_id_fkey" FOREIGN KEY ("first_appearance_chapter_id") REFERENCES "chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_first_appearance_paragraph_id_fkey" FOREIGN KEY ("first_appearance_paragraph_id") REFERENCES "paragraph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_last_appearance_book_version_id_fkey" FOREIGN KEY ("last_appearance_book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_last_appearance_chapter_id_fkey" FOREIGN KEY ("last_appearance_chapter_id") REFERENCES "chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_last_appearance_paragraph_id_fkey" FOREIGN KEY ("last_appearance_paragraph_id") REFERENCES "paragraph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_detected_by_model_version_id_fkey" FOREIGN KEY ("detected_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character" ADD CONSTRAINT "character_merged_into_character_id_fkey" FOREIGN KEY ("merged_into_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_scope_chapter_id_fkey" FOREIGN KEY ("scope_chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_scope_speaker_character_id_fkey" FOREIGN KEY ("scope_speaker_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_detected_by_model_version_id_fkey" FOREIGN KEY ("detected_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_losing_character_id_fkey" FOREIGN KEY ("losing_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_winning_character_id_fkey" FOREIGN KEY ("winning_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_performed_by_user_id_fkey" FOREIGN KEY ("performed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_merge" ADD CONSTRAINT "character_merge_reversed_by_merge_id_fkey" FOREIGN KEY ("reversed_by_merge_id") REFERENCES "character_merge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_source_character_id_fkey" FOREIGN KEY ("source_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_target_character_id_fkey" FOREIGN KEY ("target_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_relationship" ADD CONSTRAINT "character_relationship_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible" ADD CONSTRAINT "story_bible_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible" ADD CONSTRAINT "story_bible_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "story_bible_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_built_by_model_version_id_fkey" FOREIGN KEY ("built_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_supersedes_story_bible_version_id_fkey" FOREIGN KEY ("supersedes_story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "narrative_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_pov_character_id_fkey" FOREIGN KEY ("pov_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_narrative_state_id_fkey" FOREIGN KEY ("narrative_state_id") REFERENCES "narrative_state"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_semantics" ADD CONSTRAINT "scene_semantics_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_participant" ADD CONSTRAINT "scene_participant_scene_semantics_id_fkey" FOREIGN KEY ("scene_semantics_id") REFERENCES "scene_semantics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_participant" ADD CONSTRAINT "scene_participant_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_pov_character_id_fkey" FOREIGN KEY ("pov_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_previous_speaker_character_id_fkey" FOREIGN KEY ("previous_speaker_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "narrative_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_state" ADD CONSTRAINT "narrative_state_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_location" ADD CONSTRAINT "narrative_location_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_location" ADD CONSTRAINT "narrative_location_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_location" ADD CONSTRAINT "narrative_location_parent_location_id_fkey" FOREIGN KEY ("parent_location_id") REFERENCES "narrative_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_location" ADD CONSTRAINT "narrative_location_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_location" ADD CONSTRAINT "narrative_location_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_timeline_event" ADD CONSTRAINT "narrative_timeline_event_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_timeline_event" ADD CONSTRAINT "narrative_timeline_event_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_timeline_event" ADD CONSTRAINT "narrative_timeline_event_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_timeline_event" ADD CONSTRAINT "narrative_timeline_event_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_timeline_event" ADD CONSTRAINT "narrative_timeline_event_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_object" ADD CONSTRAINT "narrative_object_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_object" ADD CONSTRAINT "narrative_object_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_object" ADD CONSTRAINT "narrative_object_custody_character_id_fkey" FOREIGN KEY ("custody_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_object" ADD CONSTRAINT "narrative_object_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_object" ADD CONSTRAINT "narrative_object_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_faction" ADD CONSTRAINT "narrative_faction_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_faction" ADD CONSTRAINT "narrative_faction_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_faction" ADD CONSTRAINT "narrative_faction_allegiance_faction_id_fkey" FOREIGN KEY ("allegiance_faction_id") REFERENCES "narrative_faction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_faction" ADD CONSTRAINT "narrative_faction_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_faction" ADD CONSTRAINT "narrative_faction_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_thread" ADD CONSTRAINT "narrative_thread_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_thread" ADD CONSTRAINT "narrative_thread_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_thread" ADD CONSTRAINT "narrative_thread_evidence_scene_id_fkey" FOREIGN KEY ("evidence_scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_thread" ADD CONSTRAINT "narrative_thread_extracted_by_model_version_id_fkey" FOREIGN KEY ("extracted_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_summary" ADD CONSTRAINT "narrative_summary_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_summary" ADD CONSTRAINT "narrative_summary_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_summary" ADD CONSTRAINT "narrative_summary_generated_by_model_version_id_fkey" FOREIGN KEY ("generated_by_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_embedding" ADD CONSTRAINT "narrative_embedding_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_embedding" ADD CONSTRAINT "narrative_embedding_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narrative_embedding" ADD CONSTRAINT "narrative_embedding_embedding_model_version_id_fkey" FOREIGN KEY ("embedding_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pronunciation_entry" ADD CONSTRAINT "pronunciation_entry_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pronunciation_entry" ADD CONSTRAINT "pronunciation_entry_applies_to_character_id_fkey" FOREIGN KEY ("applies_to_character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pronunciation_entry" ADD CONSTRAINT "pronunciation_entry_applies_to_chapter_id_fkey" FOREIGN KEY ("applies_to_chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pronunciation_entry" ADD CONSTRAINT "pronunciation_entry_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_snapshotted_from_system_profile_id_fkey" FOREIGN KEY ("snapshotted_from_system_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "voice_profile_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_derived_from_version_id_fkey" FOREIGN KEY ("derived_from_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_tts_model_version_id_fkey" FOREIGN KEY ("tts_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_embedding_extractor_model_version_id_fkey" FOREIGN KEY ("embedding_extractor_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_consent_attested_by_user_id_fkey" FOREIGN KEY ("consent_attested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_voice_profile_version_id_fkey" FOREIGN KEY ("voice_profile_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_superseded_by_assignment_id_fkey" FOREIGN KEY ("superseded_by_assignment_id") REFERENCES "voice_assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assignment" ADD CONSTRAINT "voice_assignment_snapshotted_from_system_profile_id_fkey" FOREIGN KEY ("snapshotted_from_system_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_voice_profile_version_id_fkey" FOREIGN KEY ("voice_profile_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_source_paragraph_id_fkey" FOREIGN KEY ("source_paragraph_id") REFERENCES "paragraph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_tts_model_version_id_fkey" FOREIGN KEY ("tts_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_scope_chapter_id_fkey" FOREIGN KEY ("scope_chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_director_model_version_id_fkey" FOREIGN KEY ("director_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_supersedes_audio_script_id_fkey" FOREIGN KEY ("supersedes_audio_script_id") REFERENCES "audio_script"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_superseded_by_audio_script_id_fkey" FOREIGN KEY ("superseded_by_audio_script_id") REFERENCES "audio_script"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_audio_script_id_fkey" FOREIGN KEY ("audio_script_id") REFERENCES "audio_script"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_voice_profile_version_id_fkey" FOREIGN KEY ("voice_profile_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_director_model_version_id_fkey" FOREIGN KEY ("director_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_current_audio_chunk_id_fkey" FOREIGN KEY ("current_audio_chunk_id") REFERENCES "audio_chunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_supersedes_chunk_id_fkey" FOREIGN KEY ("supersedes_chunk_id") REFERENCES "audio_script_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_superseded_by_chunk_id_fkey" FOREIGN KEY ("superseded_by_chunk_id") REFERENCES "audio_script_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk_source" ADD CONSTRAINT "audio_script_chunk_source_audio_script_chunk_id_fkey" FOREIGN KEY ("audio_script_chunk_id") REFERENCES "audio_script_chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk_source" ADD CONSTRAINT "audio_script_chunk_source_paragraph_id_fkey" FOREIGN KEY ("paragraph_id") REFERENCES "paragraph"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_script_chunk_source" ADD CONSTRAINT "audio_script_chunk_source_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_audio_script_chunk_id_fkey" FOREIGN KEY ("audio_script_chunk_id") REFERENCES "audio_script_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_processing_job_id_fkey" FOREIGN KEY ("processing_job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_tts_model_version_id_fkey" FOREIGN KEY ("tts_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_voice_profile_version_id_fkey" FOREIGN KEY ("voice_profile_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_job" ADD CONSTRAINT "tts_job_audio_chunk_id_fkey" FOREIGN KEY ("audio_chunk_id") REFERENCES "audio_chunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_audio_script_chunk_id_fkey" FOREIGN KEY ("audio_script_chunk_id") REFERENCES "audio_script_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_tts_job_id_fkey" FOREIGN KEY ("tts_job_id") REFERENCES "tts_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_voice_profile_id_fkey" FOREIGN KEY ("voice_profile_id") REFERENCES "voice_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_voice_profile_version_id_fkey" FOREIGN KEY ("voice_profile_version_id") REFERENCES "voice_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_director_model_version_id_fkey" FOREIGN KEY ("director_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_tts_model_version_id_fkey" FOREIGN KEY ("tts_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_asr_model_version_id_fkey" FOREIGN KEY ("asr_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_supersedes_audio_chunk_id_fkey" FOREIGN KEY ("supersedes_audio_chunk_id") REFERENCES "audio_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_superseded_by_audio_chunk_id_fkey" FOREIGN KEY ("superseded_by_audio_chunk_id") REFERENCES "audio_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_audio_tool_model_version_id_fkey" FOREIGN KEY ("audio_tool_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_supersedes_chapter_audio_id_fkey" FOREIGN KEY ("supersedes_chapter_audio_id") REFERENCES "chapter_audio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_superseded_by_chapter_audio_id_fkey" FOREIGN KEY ("superseded_by_chapter_audio_id") REFERENCES "chapter_audio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio_member" ADD CONSTRAINT "chapter_audio_member_chapter_audio_id_fkey" FOREIGN KEY ("chapter_audio_id") REFERENCES "chapter_audio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio_member" ADD CONSTRAINT "chapter_audio_member_audio_chunk_id_fkey" FOREIGN KEY ("audio_chunk_id") REFERENCES "audio_chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_audio_member" ADD CONSTRAINT "chapter_audio_member_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_book_version_id_fkey" FOREIGN KEY ("book_version_id") REFERENCES "book_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_story_bible_version_id_fkey" FOREIGN KEY ("story_bible_version_id") REFERENCES "story_bible_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_audio_tool_model_version_id_fkey" FOREIGN KEY ("audio_tool_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_audiobook_cover_id_fkey" FOREIGN KEY ("audiobook_cover_id") REFERENCES "audiobook_cover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_supersedes_audiobook_id_fkey" FOREIGN KEY ("supersedes_audiobook_id") REFERENCES "audiobook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_superseded_by_audiobook_id_fkey" FOREIGN KEY ("superseded_by_audiobook_id") REFERENCES "audiobook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_chapter" ADD CONSTRAINT "audiobook_chapter_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "audiobook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_chapter" ADD CONSTRAINT "audiobook_chapter_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_chapter" ADD CONSTRAINT "audiobook_chapter_chapter_audio_id_fkey" FOREIGN KEY ("chapter_audio_id") REFERENCES "chapter_audio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_chapter" ADD CONSTRAINT "audiobook_chapter_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "audiobook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_audio_tool_model_version_id_fkey" FOREIGN KEY ("audio_tool_model_version_id") REFERENCES "model_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_cover" ADD CONSTRAINT "audiobook_cover_book_id_tenant_id_fkey" FOREIGN KEY ("book_id", "tenant_id") REFERENCES "book"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_cover" ADD CONSTRAINT "audiobook_cover_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "audiobook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiobook_cover" ADD CONSTRAINT "audiobook_cover_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_version" ADD CONSTRAINT "model_version_model_registry_id_fkey" FOREIGN KEY ("model_registry_id") REFERENCES "model_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "processing_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_forced_by_user_id_fkey" FOREIGN KEY ("forced_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_cancellation_requested_by_user_id_fkey" FOREIGN KEY ("cancellation_requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_attempt" ADD CONSTRAINT "processing_attempt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_attempt" ADD CONSTRAINT "processing_attempt_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_attempt" ADD CONSTRAINT "processing_attempt_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_dependency" ADD CONSTRAINT "job_dependency_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_dependency" ADD CONSTRAINT "job_dependency_depends_on_job_id_fkey" FOREIGN KEY ("depends_on_job_id") REFERENCES "processing_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- APPENDED: everything Prisma's schema language cannot express.
--
-- Everything below this line is hand-written, sourced from
-- docs/architecture/database-schema.md, and asserted by the mandatory drift
-- test (§36, §41.3 check 12). It is organised by document section. Each
-- statement's provenance is given inline. Nothing here was invented: where the
-- document under-specifies an expression exactly, that is called out with a
-- `-- TODO(doc-ambiguous):` comment rather than guessed silently (see
-- prisma/README.md for the consolidated list).
--
-- The two exceptions to "purely additive" are documented at the point they
-- occur, above: the pgvector extension bootstrap (top of file, required
-- before the base migration's own `CREATE TABLE "narrative_embedding"`) and
-- the `audit_log` primary-key widening + `PARTITION BY` (in the base
-- migration's `CREATE TABLE "audit_log"` block).
-- =============================================================================

-- =============================================================================
-- §4.3 — the content-hash column contract.
-- CHECK (col ~ '^[0-9a-f]{64}$') on every char(64) column whose name matches
-- `*content_hash`, lowercase hex SHA-256, per §4.3's "content_hash char(64)
-- with a CHECK (content_hash ~ '^[0-9a-f]{64}$')" contract and §36's
-- "check constraints ... not expressible in Prisma". Nullable columns permit
-- NULL; NOT NULL columns do not need the NULL branch but it is harmless and
-- keeps every constraint in this section textually uniform.
-- =============================================================================

ALTER TABLE "book_file" ADD CONSTRAINT "book_file_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "book_version" ADD CONSTRAINT "book_version_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_raw_text_content_hash_hex_chk" CHECK ("raw_text_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_parsed_document_content_hash_hex_chk" CHECK ("parsed_document_content_hash" IS NULL OR "parsed_document_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_ocr_report_content_hash_hex_chk" CHECK ("ocr_report_content_hash" IS NULL OR "ocr_report_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "book_version" ADD CONSTRAINT "book_version_canonical_text_manifest_content_hash_hex_chk" CHECK ("canonical_text_manifest_content_hash" IS NULL OR "canonical_text_manifest_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "chapter" ADD CONSTRAINT "chapter_canonical_text_content_hash_hex_chk" CHECK ("canonical_text_content_hash" IS NULL OR "canonical_text_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_raw_text_content_hash_hex_chk" CHECK ("raw_text_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "story_bible_version" ADD CONSTRAINT "story_bible_version_facts_content_hash_hex_chk" CHECK ("facts_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "narrative_summary" ADD CONSTRAINT "narrative_summary_target_content_hash_hex_chk" CHECK ("target_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "narrative_embedding" ADD CONSTRAINT "narrative_embedding_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_reference_audio_content_hash_hex_chk" CHECK ("reference_audio_content_hash" IS NULL OR "reference_audio_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_embedding_content_hash_hex_chk" CHECK ("embedding_content_hash" IS NULL OR "embedding_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "voice_preview" ADD CONSTRAINT "voice_preview_content_hash_hex_chk" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_source_content_hash_hex_chk" CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "audiobook_cover" ADD CONSTRAINT "audiobook_cover_content_hash_hex_chk" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "model_version" ADD CONSTRAINT "model_version_weights_content_hash_hex_chk" CHECK ("weights_content_hash" IS NULL OR "weights_content_hash" ~ '^[0-9a-f]{64}$');

-- =============================================================================
-- §7.1 `tenant`, §7.2 `user` — schema.prisma line ~855, ~883.
-- =============================================================================

CREATE INDEX "tenant_status_active_idx" ON "tenant"("status") WHERE "deleted_at" IS NULL;

-- email is citext in PostgreSQL; Prisma has no citext type (schema.prisma line ~883).
ALTER TABLE "user" ALTER COLUMN "email" TYPE CITEXT;

CREATE INDEX "user_tenant_id_active_idx" ON "user"("tenant_id") WHERE "deleted_at" IS NULL;

-- =============================================================================
-- §8.1 `book` — schema.prisma line ~1051-1053: "All six of its list indexes
-- are partial and therefore live in migration.sql." `UNIQUE (id, tenant_id)`
-- is already `@@unique([id, tenantId])` in schema.prisma; the remaining five
-- are partial and are added here.
-- =============================================================================

CREATE INDEX "book_tenant_id_created_at_idx" ON "book"("tenant_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "book_tenant_id_status_idx" ON "book"("tenant_id", "status") WHERE "deleted_at" IS NULL;
CREATE INDEX "book_tenant_id_language_idx" ON "book"("tenant_id", "language") WHERE "deleted_at" IS NULL;
CREATE INDEX "book_tenant_id_lower_title_idx" ON "book"("tenant_id", lower("title")) WHERE "deleted_at" IS NULL;
CREATE INDEX "book_deleted_at_idx" ON "book"("deleted_at") WHERE "deleted_at" IS NOT NULL;

-- =============================================================================
-- §8.2 `book_file`, §8.3 `book_version` — §25.1 constraints #12, #13.
-- Not individually flagged in schema.prisma by name, but required by the
-- constraint inventory of §25.1 ("this schema depends on eighteen of them",
-- §36) and impossible to express as a Prisma partial unique index.
-- =============================================================================

-- §8.2: within-tenant dedupe. The second copy of a duplicate-with-consent
-- upload carries deduplicated_from_book_file_id and is deliberately excluded.
CREATE UNIQUE INDEX "book_file_tenant_id_content_hash_admitted_key" ON "book_file"("tenant_id", "content_hash") WHERE "status" = 'ADMITTED' AND "deduplicated_from_book_file_id" IS NULL;

-- §8.3: exactly one current version per book.
CREATE UNIQUE INDEX "book_version_current_key" ON "book_version"("book_id") WHERE "is_current";
-- §8.3 / §25.1 #12: structural-ingest idempotency.
CREATE UNIQUE INDEX "book_version_pipeline_content_hash_key" ON "book_version"("book_id", "pipeline_version", "content_hash") WHERE "superseded_at" IS NULL;

-- =============================================================================
-- §9.3 `chapter` — schema.prisma line ~1337-1338: "UNIQUE (book_version_id,
-- order_index) is DEFERRABLE (§25.2) and is therefore declared in
-- migration.sql, not here." Deferrable so a chapter reorder can renumber
-- siblings inside one transaction without tripping the constraint mid-update.
-- =============================================================================

ALTER TABLE "chapter" ADD CONSTRAINT "chapter_book_version_id_order_index_key" UNIQUE ("book_version_id", "order_index") DEFERRABLE INITIALLY IMMEDIATE;

-- §9.3 `scene`: "never cross a chapter boundary" companion check.
ALTER TABLE "scene" ADD CONSTRAINT "scene_spine_range_chk" CHECK ("spine_start" <= "spine_end");

-- =============================================================================
-- §10.1 `character` — is_sentinel/sentinel_kind CHECK and the one-sentinel-
-- per-book partial unique (§25.1 #14). Not individually flagged with a
-- "migration.sql" comment in schema.prisma, but named explicitly in §25.1 and
-- impossible to express in Prisma.
-- =============================================================================

ALTER TABLE "character" ADD CONSTRAINT "character_is_sentinel_chk" CHECK ("is_sentinel" = ("sentinel_kind" IS NOT NULL));
CREATE UNIQUE INDEX "character_book_id_sentinel_kind_key" ON "character"("book_id", "sentinel_kind") WHERE "sentinel_kind" IS NOT NULL;

-- =============================================================================
-- §10.2 `character_alias` — schema.prisma line ~1574-1577: the ambiguity-
-- refusal exclusion constraint and the generated `scope_key` column, neither
-- expressible in Prisma. Requires btree_gist (bootstrapped at the top of this
-- file).
-- =============================================================================

ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_valid_range_chk" CHECK ("valid_from_spine" IS NULL OR "valid_to_spine" IS NULL OR "valid_from_spine" <= "valid_to_spine");
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_scope_chapter_chk" CHECK (("scope_kind" = 'CHAPTER') = ("scope_chapter_id" IS NOT NULL));
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_scope_speaker_chk" CHECK (("scope_kind" = 'SPEAKER') = ("scope_speaker_character_id" IS NOT NULL));

-- TODO(doc-ambiguous): §10.2 specifies scope_key only as "a generated column
-- combining scope_kind with its scope id", without an exact expression. The
-- formula below is this migration's best-effort transcription (GLOBAL has no
-- scope id; CHAPTER/SPEAKER concatenate the enum tag with the relevant scope
-- id so two different scopes of the same kind never collide). Confirm against
-- an authoritative source before relying on scope_key for anything beyond the
-- exclusion constraint it exists to support.
ALTER TABLE "character_alias" ADD COLUMN "scope_key" TEXT GENERATED ALWAYS AS (
  CASE "scope_kind"
    WHEN 'CHAPTER' THEN 'CHAPTER:' || "scope_chapter_id"::text
    WHEN 'SPEAKER' THEN 'SPEAKER:' || "scope_speaker_character_id"::text
    ELSE 'GLOBAL'
  END
) STORED;

-- The ambiguity-refusal exclusion constraint itself: the same surface form, in
-- the same scope, with an overlapping validity range, must not resolve to two
-- characters. NULL valid_from_spine/valid_to_spine bounds are unbounded in
-- int4range, i.e. an alias with no declared validity window is treated as
-- valid everywhere and will correctly conflict with any other range for the
-- same (book_id, surface_form_normalized, scope_key).
ALTER TABLE "character_alias" ADD CONSTRAINT "character_alias_no_overlap_excl" EXCLUDE USING gist (
  "book_id" WITH =,
  "surface_form_normalized" WITH =,
  "scope_key" WITH =,
  int4range("valid_from_spine", "valid_to_spine") WITH &&
);

-- This is also the resolution lookup index (§10.2), so no separate index is
-- needed for "all aliases of this surface form in this scope, ordered by
-- validity". §10.2's other two plain indexes (character_id;
-- book_id+surface_form_normalized) are already `@@index` in schema.prisma.

-- =============================================================================
-- §11.8 `narrative_embedding` — schema.prisma line ~2034-2035: "The HNSW
-- index is created in migration.sql." The `vector(1536)` column itself is
-- already created by the base migration (via Prisma's
-- `Unsupported("vector(1536)")`); this is only the index.
--
-- TODO(doc-ambiguous) / OQ-DB-12: neither the embedding dimension (1536) nor
-- the distance metric is fixed by any architecture document (§44 OQ-DB-12:
-- "Which embedding model and dimension are pinned ... this should be decided
-- before Phase 6"). `vector_cosine_ops` is a reasonable default for
-- text-embedding similarity search, not a value transcribed from the doc.
-- Revisit both the column width and the operator class once OQ-DB-12 is
-- resolved — changing either is a table rewrite (§11.8).
-- =============================================================================

CREATE INDEX "narrative_embedding_embedding_hnsw_idx" ON "narrative_embedding" USING hnsw ("embedding" vector_cosine_ops);

-- =============================================================================
-- §12.1 `voice_profile` — the scope/tenant/book consistency checks and the
-- two partial-unique name indexes. Not individually flagged with a
-- "migration.sql" comment, named explicitly in §12.1's prose and impossible
-- to express in Prisma (partial unique on lower(name), and a scope-dependent
-- CHECK).
-- =============================================================================

ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_scope_book_chk" CHECK (("scope" = 'BOOK') = ("book_id" IS NOT NULL));
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_scope_system_chk" CHECK (("scope" = 'SYSTEM') = ("tenant_id" IS NULL));

CREATE UNIQUE INDEX "voice_profile_tenant_lower_name_key" ON "voice_profile"("tenant_id", lower("name")) WHERE "scope" = 'TENANT' AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "voice_profile_book_lower_name_key" ON "voice_profile"("book_id", lower("name")) WHERE "scope" = 'BOOK' AND "deleted_at" IS NULL;

-- =============================================================================
-- §12.2 `voice_profile_version` — schema.prisma line ~2185: consent (§25.1
-- #6), plus the lock-state CHECK named in the same subsection (§12.2).
-- =============================================================================

-- §9.3 rule 6 / §25.1 #6: an unattested row is unrepresentable.
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_consent_attested_chk" CHECK ("consent_attested");
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_consent_subject_text_chk" CHECK ("consent_subject" <> 'THIRD_PARTY_CONSENTED' OR "consent_attestation_text" IS NOT NULL);
-- §12.2: "nothing, forever" once LOCKED — physically backed by requiring
-- locked_at and locked_reason together with the state.
ALTER TABLE "voice_profile_version" ADD CONSTRAINT "voice_profile_version_lock_state_chk" CHECK ("lock_state" <> 'LOCKED' OR ("locked_at" IS NOT NULL AND "locked_reason" IS NOT NULL));

-- =============================================================================
-- §12.3 `voice_assignment` — schema.prisma line ~2229-2231: "UNIQUE (book_id,
-- character_id, role) WHERE is_active lives in migration.sql." (§25.1 #8)
-- =============================================================================

CREATE UNIQUE INDEX "voice_assignment_active_key" ON "voice_assignment"("book_id", "character_id", "role") WHERE "is_active";
-- §12.3: the casting-gate query.
CREATE INDEX "voice_assignment_book_id_active_idx" ON "voice_assignment"("book_id") WHERE "is_active";

-- =============================================================================
-- §13.1 `audio_script` — exactly one current version per book, and the
-- coverage invariant (§25.1 #4). Not individually flagged in schema.prisma,
-- named explicitly in §13.1 and impossible to express in Prisma.
-- =============================================================================

CREATE UNIQUE INDEX "audio_script_current_key" ON "audio_script"("book_id") WHERE "is_current";
ALTER TABLE "audio_script" ADD CONSTRAINT "audio_script_coverage_invariant_chk" CHECK ("state" <> 'VALIDATED' OR ("coverage_verified" AND "coverage_gap_count" = 0 AND "coverage_overlap_count" = 0));

-- =============================================================================
-- §13.2 `audio_script_chunk` — schema.prisma line ~2381-2383: "has_review_flags
-- is GENERATED ALWAYS AS ... STORED and therefore is NOT declared here — it
-- is added in migration.sql (§23.3, §36)." Plus the chunk-ordering unique
-- (§25.1 #19) and the three CHECK constraints §13.2 names explicitly.
-- =============================================================================

CREATE UNIQUE INDEX "audio_script_chunk_sequence_current_key" ON "audio_script_chunk"("audio_script_id", "sequence_index") WHERE "is_current";

ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_speaker_character_chk" CHECK ("speaker_type" <> 'CHARACTER' OR "character_id" IS NOT NULL);
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_locked_chk" CHECK ("state" <> 'LOCKED' OR ("voice_profile_version_id" IS NOT NULL AND "locked_at" IS NOT NULL));
-- §13.2's "six fields added by this revision": IR-6 relaxes the prior blanket
-- non-empty-text constraint for a non-verbal-only chunk.
ALTER TABLE "audio_script_chunk" ADD CONSTRAINT "audio_script_chunk_text_or_non_verbal_chk" CHECK (char_length("text") > 0 OR "non_verbal" IS NOT NULL);

-- §23.3: "has_capability_gap and has_review_flags are ... generated boolean
-- columns promoted out of JSONB precisely because the API filters on them."
-- review_flags is a `review_flag[]` array (not JSONB); "has review flags" is
-- "the array is non-empty".
ALTER TABLE "audio_script_chunk" ADD COLUMN "has_review_flags" BOOLEAN GENERATED ALWAYS AS ("review_flags" IS NOT NULL AND cardinality("review_flags") > 0) STORED;

-- §13.2: "INDEX (audio_script_id) WHERE has_review_flags AND is_current — the
-- review queue" — the query has_review_flags exists to serve.
CREATE INDEX "audio_script_chunk_review_queue_idx" ON "audio_script_chunk"("audio_script_id") WHERE "has_review_flags" AND "is_current";

-- =============================================================================
-- §15.1 `processing_job` — five CHECK constraints and the idempotency partial
-- unique index (§21.2), plus the operational partial indexes §15.1 names,
-- including "the single most important operational index in the table" (the
-- orphan reaper). Not individually flagged in schema.prisma, named explicitly
-- in §15.1 and impossible to express in Prisma.
-- =============================================================================

ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_attempt_count_chk" CHECK ("attempt_count" <= "max_attempts" + 1);
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_succeeded_completed_at_chk" CHECK ("status" <> 'SUCCEEDED' OR "completed_at" IS NOT NULL);
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_terminal_error_code_chk" CHECK ("status" NOT IN ('FAILED', 'DEAD_LETTERED') OR "error_code" IS NOT NULL);
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_progress_range_chk" CHECK ("progress" >= 0 AND "progress" <= 1);
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_book_scoped_chk" CHECK ("book_id" IS NOT NULL OR "type" = 'cleanup_artifacts');

CREATE UNIQUE INDEX "processing_job_tenant_idempotency_key" ON "processing_job"("tenant_id", "idempotency_key") WHERE "status" NOT IN ('FAILED', 'CANCELLED', 'DEAD_LETTERED');
CREATE INDEX "processing_job_retrying_idx" ON "processing_job"("status", "next_attempt_at") WHERE "status" = 'RETRYING';
CREATE INDEX "processing_job_running_heartbeat_idx" ON "processing_job"("status", "heartbeat_at") WHERE "status" = 'RUNNING';
CREATE INDEX "processing_job_queue_reconciliation_idx" ON "processing_job"("queue", "priority", "created_at") WHERE "status" IN ('CREATED', 'QUEUED');
CREATE INDEX "processing_job_parent_job_id_idx" ON "processing_job"("parent_job_id") WHERE "parent_job_id" IS NOT NULL;
CREATE INDEX "processing_job_dead_lettered_idx" ON "processing_job"("created_at") WHERE "status" = 'DEAD_LETTERED';

-- =============================================================================
-- §15.3 `job_dependency` — schema.prisma line ~3164-3165: "UNIQUE (job_id,
-- depends_on_job_id, gate_key) NULLS NOT DISTINCT (PostgreSQL 15+). Prisma
-- cannot emit NULLS NOT DISTINCT, so it lives in migration.sql."
-- =============================================================================

ALTER TABLE "job_dependency" ADD CONSTRAINT "job_dependency_unique_dependency" UNIQUE NULLS NOT DISTINCT ("job_id", "depends_on_job_id", "gate_key");
ALTER TABLE "job_dependency" ADD CONSTRAINT "job_dependency_kind_depends_on_chk" CHECK (("kind" = 'UPSTREAM_JOB') = ("depends_on_job_id" IS NOT NULL));

CREATE INDEX "job_dependency_unblocks_idx" ON "job_dependency"("depends_on_job_id") WHERE "satisfied_at" IS NULL;
CREATE INDEX "job_dependency_gate_key_idx" ON "job_dependency"("gate_key") WHERE "satisfied_at" IS NULL AND "gate_key" IS NOT NULL;

-- =============================================================================
-- §15.5 `worker` — one of the three named GIN indexes of §23.3.
-- =============================================================================

CREATE INDEX "worker_capabilities_gin_idx" ON "worker" USING gin ("capabilities" jsonb_path_ops);
CREATE INDEX "worker_quarantined_idx" ON "worker"("status") WHERE "status" = 'QUARANTINED';

-- =============================================================================
-- §15.6 `outbox_message` — the publish-outcome CHECK named in §15.6's
-- "Constraints" bullet.
-- =============================================================================

ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_published_at_chk" CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL);

-- =============================================================================
-- §16.2 `audio_chunk` — schema.prisma line ~2567-2571: the bytes-exist
-- invariant (§25.1 #2 / #3), has_capability_gap as GENERATED ALWAYS AS ...
-- STORED, and the composite FK that keeps the denormalised character_id
-- honest: "(audio_script_chunk_id, character_id) -> audio_script_chunk (id,
-- character_id) ... Prisma cannot express a composite relation whose fields
-- differ in nullability." The target unique index, audio_script_chunk
-- (id, character_id), already exists via schema.prisma's
-- `@@unique([id, characterId])`.
-- =============================================================================

-- §25.1 #2: no artifact is marked valid whose bytes were never verified.
ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_bytes_exist_chk" CHECK ("status" NOT IN ('GENERATED', 'VALIDATED', 'ASSEMBLED') OR "object_verified_at" IS NOT NULL);
-- §25.1 #3: exactly one current rendering per script chunk.
CREATE UNIQUE INDEX "audio_chunk_current_key" ON "audio_chunk"("audio_script_chunk_id") WHERE "is_current";

ALTER TABLE "audio_chunk" ADD COLUMN "has_capability_gap" BOOLEAN GENERATED ALWAYS AS ("capability_gaps" IS NOT NULL AND jsonb_array_length("capability_gaps") > 0) STORED;
CREATE INDEX "audio_chunk_capability_gap_idx" ON "audio_chunk"("book_id") WHERE "is_current" AND "has_capability_gap";

ALTER TABLE "audio_chunk" ADD CONSTRAINT "audio_chunk_script_chunk_character_fkey" FOREIGN KEY ("audio_script_chunk_id", "character_id") REFERENCES "audio_script_chunk"("id", "character_id");

-- =============================================================================
-- §16.3 `chapter_audio` — the assembly-idempotency partial unique and the
-- voice-consistency CHECK (§25.1 #10, #11). Not individually flagged in
-- schema.prisma, named explicitly in §16.3 and impossible to express in
-- Prisma.
-- =============================================================================

CREATE UNIQUE INDEX "chapter_audio_manifest_key" ON "chapter_audio"("chapter_id", "chunk_manifest_hash") WHERE NOT "is_preview_build";
CREATE UNIQUE INDEX "chapter_audio_current_key" ON "chapter_audio"("chapter_id") WHERE "is_current" AND NOT "is_preview_build";
ALTER TABLE "chapter_audio" ADD CONSTRAINT "chapter_audio_voice_consistency_chk" CHECK ("status" <> 'ASSEMBLED' OR "is_preview_build" OR "voice_consistency_verified");

-- =============================================================================
-- §16.5 `audiobook` — the AI-narration-disclosure CHECK (§25.1 #5), the
-- READY/object_verified_at CHECK, and the current-version partial unique.
-- Not individually flagged in schema.prisma, named explicitly in §16.5 and
-- impossible to express in Prisma.
-- =============================================================================

ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_ai_narration_disclosed_chk" CHECK ("ai_narration_disclosed");
ALTER TABLE "audiobook" ADD CONSTRAINT "audiobook_ready_object_verified_chk" CHECK ("status" <> 'READY' OR "object_verified_at" IS NOT NULL);
CREATE UNIQUE INDEX "audiobook_current_key" ON "audiobook"("book_id") WHERE "is_current" AND NOT "is_preview_build";

-- =============================================================================
-- §16.7 `audiobook_rendition` — the format/chapter_id CHECK and the
-- NULLS NOT DISTINCT unique index ("one row per (audiobook, format,
-- chapter)", including the single non-per-chapter formats where chapter_id is
-- NULL). Structurally identical to job_dependency's NULLS NOT DISTINCT need
-- (§15.3, schema.prisma line ~3164-3165); not individually flagged in
-- schema.prisma but named explicitly in §16.7 with the same PostgreSQL-15+
-- syntax Prisma cannot emit.
-- =============================================================================

ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_mp3_per_chapter_chk" CHECK (("format" = 'MP3_PER_CHAPTER') = ("chapter_id" IS NOT NULL));
ALTER TABLE "audiobook_rendition" ADD CONSTRAINT "audiobook_rendition_unique_target" UNIQUE NULLS NOT DISTINCT ("audiobook_id", "format", "chapter_id");

-- =============================================================================
-- §14.3 `model_version` — one of the three named GIN indexes of §23.3.
-- =============================================================================

CREATE INDEX "model_version_config_gin_idx" ON "model_version" USING gin ("config" jsonb_path_ops);

-- =============================================================================
-- §17.1 `audit_log` — schema.prisma line ~3222-3224: "PARTITIONED BY RANGE
-- (occurred_at) ... the partitioning (and the PK widening it forces) is
-- applied in migration.sql." The PARTITION BY clause and PK widening are
-- applied in place on the base migration's `CREATE TABLE "audit_log"`
-- statement (the one other necessary exception to "append only", documented
-- there). This section adds the third named GIN index of §23.3 and the
-- initial partitions a freshly-migrated database needs in order to accept any
-- INSERT at all (a partitioned table with zero partitions and no DEFAULT
-- partition rejects every row).
--
-- Partition creation going forward (rolling monthly partitions, retention via
-- DETACH PARTITION) is an operational job, not part of this base migration —
-- see prisma/README.md. No DEFAULT partition is created: per §17.1's "monthly
-- range partitions ... created from day one", the intended operating model is
-- that the partition-maintenance job stays ahead of the current month, and a
-- DEFAULT partition would complicate future `ATTACH PARTITION` operations for
-- comparatively little benefit in an append-only, time-ordered log.
-- =============================================================================

CREATE INDEX "audit_log_metadata_gin_idx" ON "audit_log" USING gin ("metadata" jsonb_path_ops);

CREATE TABLE "audit_log_2026_08" PARTITION OF "audit_log"
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');

CREATE TABLE "audit_log_2026_09" PARTITION OF "audit_log"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

