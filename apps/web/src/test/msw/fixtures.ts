import type {
  Audiobook,
  AudiobookProject,
  AudioScriptChunk,
  Book,
  BookProgress,
  BookWithStages,
  Capabilities,
  CastingState,
  Chapter,
  Character,
  Job,
  VoiceProfile,
  VoiceProfileVersion,
} from '@/lib/api/types';

/**
 * Fixtures shaped exactly like the Phase 8 DTOs.
 *
 * Field-for-field with `books.service.ts`, `progress.service.ts`,
 * `voice.service.ts`, `assembly.service.ts`, and `director.service.ts`, so a
 * component that renders these renders what the API actually sends. The
 * contract tests in `src/test/contract` assert the enum vocabularies used here
 * against the API's own closed lists.
 */

export const BOOK_ID = '01890000-0000-7000-8000-000000000001';
export const CHAPTER_ID = '01890000-0000-7000-8000-0000000000c1';
export const CHARACTER_ID = '01890000-0000-7000-8000-0000000000a1';
export const VOICE_PROFILE_ID = '01890000-0000-7000-8000-0000000000v1'.replace('v', 'b');
export const AUDIOBOOK_ID = '01890000-0000-7000-8000-0000000000d1';
export const CHUNK_ID = '01890000-0000-7000-8000-0000000000e1';
export const JOB_ID = '01890000-0000-7000-8000-0000000000f1';

export function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: BOOK_ID,
    object: 'book',
    tenant_id: 'tenant-1',
    title: 'The Long Voyage',
    author: 'A. Writer',
    language: 'en-GB',
    description: 'A test book.',
    metadata: { series: null, series_index: null, publication_year: null, publisher: null },
    status: 'GENERATING',
    pipeline_version: '1.0.0',
    needs_review: false,
    current_book_version_id: 'bv-1',
    current_audio_script_id: 'as-1',
    current_audiobook_id: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-27T15:04:03.221Z',
    deleted_at: null,
    links: { self: `/api/v1/books/${BOOK_ID}` },
    ...overrides,
  };
}

export function makeBookWithStages(overrides: Partial<BookWithStages> = {}): BookWithStages {
  return {
    ...makeBook(),
    stages: {
      ingestion: { status: 'COMPLETED', progress: 1, completed_units: 412, total_units: 412 },
      analysis: { status: 'COMPLETED', progress: 1, completed_units: 88, total_units: 88 },
      director: { status: 'COMPLETED', progress: 1, completed_units: 1, total_units: 1 },
      tts: { status: 'RUNNING', progress: 0.61, completed_units: 5180, total_units: 8420 },
      assembly: { status: 'NOT_STARTED', progress: null, completed_units: 0, total_units: null },
    },
    ...overrides,
  };
}

export function makeProgress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    object: 'book_progress',
    book_id: BOOK_ID,
    book_status: 'GENERATING',
    overall_progress: 0.58,
    degraded: false,
    degraded_reasons: [],
    stages: [
      {
        stage: 'ingestion',
        status: 'COMPLETED',
        progress: 1,
        completed_units: 412,
        total_units: 412,
        failed_units: 0,
        flagged_units: 0,
      },
      {
        stage: 'analysis',
        status: 'COMPLETED',
        progress: 1,
        completed_units: 88,
        total_units: 88,
        failed_units: 0,
        flagged_units: 0,
      },
      {
        stage: 'director',
        status: 'COMPLETED',
        progress: 1,
        completed_units: 1,
        total_units: 1,
        failed_units: 0,
        flagged_units: 4,
      },
      {
        stage: 'tts',
        status: 'RUNNING',
        progress: 0.61,
        completed_units: 5180,
        total_units: 8420,
        failed_units: 14,
        flagged_units: 6,
      },
      {
        stage: 'assembly',
        status: 'NOT_STARTED',
        progress: null,
        completed_units: 0,
        total_units: null,
        failed_units: 0,
        flagged_units: 0,
      },
    ],
    active_job_ids: [JOB_ID],
    needs_review: false,
    needs_review_count: 10,
    estimate: {
      remaining_ms: 9_420_000,
      confidence: 'LOW',
      basis: 'COMPLETED_UNIT_RATE',
      computed_at: '2026-08-27T15:04:03.221Z',
    },
    queue: { position: null, backpressure: null },
    updated_at: '2026-08-27T15:04:03.221Z',
    links: {},
    ...overrides,
  };
}

export function makeChapters(count = 12): Chapter[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? CHAPTER_ID : `${CHAPTER_ID}-${index}`,
    order_index: index,
    spine_start: index * 100,
    spine_end: index * 100 + 99,
    title: `Chapter ${index + 1}`,
    matter_type: 'BODY',
    char_count: 12_000 + index * 100,
    text_qc_outcome: 'OK',
  }));
}

export function makeCharacters(count = 6): Character[] {
  const names = ['Marlow', 'Captain Reyes', 'The Cook', 'Elena', 'Narrator', 'Old Tom'];
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? CHARACTER_ID : `${CHARACTER_ID}-${index}`,
    object: 'character' as const,
    book_id: BOOK_ID,
    display_name: names[index] ?? `Character ${index + 1}`,
    status: 'ACTIVE',
    is_sentinel: names[index] === 'Narrator',
    sentinel_kind: names[index] === 'Narrator' ? 'NARRATOR' : null,
    importance_rank: index + 1,
    line_count: 500 - index * 40,
    speaking: true,
    pronoun_sets: null,
    speech_traits: null,
    first_appearance: { chapter_id: CHAPTER_ID, paragraph_id: null },
    last_appearance: { chapter_id: CHAPTER_ID, paragraph_id: null },
    detection: {
      source: 'LLM',
      model_version_id: 'mv-1',
      confidence: 0.92 - index * 0.05,
      evidence_paragraph_ids: [],
    },
    merged_into_character_id: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
  }));
}

export function makeCasting(overrides: Partial<CastingState> = {}): CastingState {
  return {
    object: 'casting_state',
    book_id: BOOK_ID,
    ready_for_generation: false,
    speaking_character_count: 6,
    assigned_count: 4,
    approved_count: 4,
    blocking: [
      {
        character_id: `${CHARACTER_ID}-1`,
        display_name: 'Captain Reyes',
        line_count: 460,
        reason: 'NO_ASSIGNMENT',
      },
      {
        character_id: `${CHARACTER_ID}-2`,
        display_name: 'The Cook',
        line_count: 420,
        reason: 'ASSIGNMENT_NOT_APPROVED',
      },
    ],
    ...overrides,
  };
}

export function makeVoiceProfiles(): VoiceProfile[] {
  return [
    {
      id: VOICE_PROFILE_ID,
      object: 'voice_profile',
      tenant_id: 'tenant-1',
      scope: 'TENANT',
      book_id: null,
      name: 'Warm Narrator',
      description: 'Measured, low register.',
      active_version: 3,
      lock_state: 'UNLOCKED',
      version_count: 3,
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
    },
  ];
}

export function makeVoiceVersions(): VoiceProfileVersion[] {
  return [
    {
      id: 'vv-3',
      object: 'voice_profile_version',
      voice_profile_id: VOICE_PROFILE_ID,
      version: 3,
      supersedes_version_id: 'vv-2',
      approval_state: 'APPROVED',
      lock_state: 'UNLOCKED',
      locked_at: null,
      locked_reason: null,
      tts_provider_id: 'xtts',
      tts_model_version_id: 'mv-tts-1',
      language: 'en-GB',
      supported_languages: ['en-GB', 'en-US'],
      base_generation_params: {},
      base_generation_params_hash: 'abc',
      emotion_capability_map: {},
      consent: { attested: true, subject: 'SYNTHETIC' },
      created_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
    },
    {
      id: 'vv-2',
      object: 'voice_profile_version',
      voice_profile_id: VOICE_PROFILE_ID,
      version: 2,
      supersedes_version_id: null,
      approval_state: 'DRAFT',
      lock_state: 'UNLOCKED',
      locked_at: null,
      locked_reason: null,
      tts_provider_id: 'xtts',
      tts_model_version_id: 'mv-tts-1',
      language: 'de-DE',
      supported_languages: ['de-DE'],
      base_generation_params: {},
      base_generation_params_hash: 'def',
      emotion_capability_map: {},
      consent: { attested: true, subject: 'SELF' },
      created_at: '2026-07-15T10:00:00.000Z',
      updated_at: '2026-07-15T10:00:00.000Z',
    },
  ];
}

export function makeScriptChunk(overrides: Partial<AudioScriptChunk> = {}): AudioScriptChunk {
  return {
    id: CHUNK_ID,
    object: 'audio_script_chunk',
    audio_script_id: 'as-1',
    book_id: BOOK_ID,
    chapter_id: CHAPTER_ID,
    sequence_index: 42,
    chapter_sequence_index: 7,
    state: 'VALIDATED',
    content: {
      text: 'He said nothing for a long moment. <script>alert(1)</script> Then: “We turn back.”',
      spoken_text: null,
      language: 'en-GB',
      script: null,
    },
    performance: {
      speaker_type: 'CHARACTER',
      character_id: CHARACTER_ID,
      is_dialogue: true,
      delivery_mode: 'NORMAL',
      emotion: 'SOMBER',
      emotion_intensity: 0.6,
      pacing: 1,
      pitch: 0,
      volume: 0,
    },
    confidence: 0.42,
    review_flags: ['LOW_CONFIDENCE', 'UNKNOWN_SPEAKER'],
    fallback_applied: false,
    fallback_reason: null,
    capability_gaps: null,
    current_audio_chunk_id: 'ac-1',
    created_at: '2026-08-20T10:00:00.000Z',
    updated_at: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

export function makeAudiobookProject(
  overrides: Partial<AudiobookProject> = {},
): AudiobookProject {
  return {
    object: 'audiobook_project',
    book_id: BOOK_ID,
    generation_status: 'COMPLETED',
    current_audiobook_id: AUDIOBOOK_ID,
    current_version: 2,
    version_count: 2,
    chapters: makeChapters(3).map((chapter) => ({
      chapter_id: chapter.id,
      order_index: chapter.order_index,
      title: chapter.title,
      chapter_audio_id: `ca-${chapter.order_index}`,
      status: 'ASSEMBLED',
      duration_ms: 1_800_000,
    })),
    totals: { chapters: 3, chapters_assembled: 3, duration_ms: 5_400_000 },
    blocking: [],
    links: {},
    ...overrides,
  };
}

export function makeAudiobook(overrides: Partial<Audiobook> = {}): Audiobook {
  return {
    id: AUDIOBOOK_ID,
    object: 'audiobook',
    book_id: BOOK_ID,
    version: 2,
    supersedes_audiobook_id: 'ab-1',
    is_current: true,
    is_preview_build: false,
    status: 'READY',
    container_format: 'M4B',
    available_formats: ['M4B'],
    duration_ms: 5_400_000,
    size_bytes: 512_000_000,
    chapter_manifest: makeChapters(3).map((chapter) => ({
      chapter_id: chapter.id,
      chapter_audio_id: `ca-${chapter.order_index}`,
      order_index: chapter.order_index,
      title: chapter.title,
      start_ms: chapter.order_index * 1_800_000,
      duration_ms: 1_800_000,
    })),
    metadata: {
      title: 'The Long Voyage',
      author: 'A. Writer',
      narrator_credit: 'Synthetic narration',
      ai_narration_disclosed: true,
      series: null,
      series_index: null,
      publisher: null,
      language: 'en-GB',
      publication_year: null,
      description: null,
    },
    cover: { present: false },
    quality: { book_wer: 0.021, chunks_flagged: 6, asr_coverage: 0.15 },
    lineage: {},
    created_at: '2026-08-26T10:00:00.000Z',
    links: {},
    ...overrides,
  };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    object: 'job',
    type: 'generate_tts_chunk',
    status: 'RUNNING',
    book_id: BOOK_ID,
    parent_job_id: null,
    attempt_count: 1,
    max_attempts: 3,
    next_attempt_at: null,
    cancellation: { requested: false, requested_at: null, requested_by: null, effective: false },
    result: null,
    error: null,
    created_at: '2026-08-27T14:00:00.000Z',
    started_at: '2026-08-27T14:01:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

export function makeCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    object: 'capabilities',
    api_version: 'v1',
    degraded: true,
    degraded_reasons: ['WORKER_CAPABILITY_REGISTRY_UNAVAILABLE'],
    limits: {
      max_page_limit: 100,
      default_page_limit: 25,
      max_request_body_bytes: 1_048_576,
      max_upload_bytes: { PDF: 209_715_200, EPUB: 209_715_200 },
      signed_url_max_expiry_seconds: 900,
      max_batch_ids: 500,
      max_pages_per_book: 2000,
    },
    upload: {
      accepted_mime_types: ['application/pdf', 'application/epub+zip'],
      multipart_threshold_bytes: null,
    },
    tts_providers: [
      {
        tts_provider_id: 'xtts',
        model_id: 'xtts-v2',
        model_version_id: 'mv-tts-1',
        version: '2.0.3',
        capabilities: null,
        available: null,
      },
    ],
    director_versions: [{ director_version: '1.2.0', model_id: 'llm-a', current: false }],
    delivery_formats: ['M4B', 'M4A', 'MP3_PER_CHAPTER'],
    vocabularies: {
      emotion: [
        'NEUTRAL',
        'HAPPY',
        'SAD',
        'GRIEF',
        'ANGRY',
        'FEARFUL',
        'SURPRISED',
        'DISGUSTED',
        'EXCITED',
        'CALM',
        'TENSE',
        'ANXIOUS',
        'SOMBER',
        'CONFIDENT',
        'UNCERTAIN',
        'PLAYFUL',
        'SERIOUS',
      ],
      delivery_mode: [
        'NORMAL',
        'INTERNAL_THOUGHT',
        'WHISPER',
        'SHOUT',
        'LAUGHING',
        'CRYING',
        'SINGING',
        'READING_ALOUD',
      ],
    },
    links: {},
    ...overrides,
  };
}
