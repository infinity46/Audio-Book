# Master Project Context — Audiobook Production Platform

> **Document type:** Architecture Contract (Tier 0 — Root Authority)
> **Path:** `docs/architecture/context.md`
> **Status:** DRAFT — pending human review
> **Schema/Doc version:** `context.v1`
> **Owner:** Architecture
> **Supersedes:** nothing (initial document)

---

## 0. How to read this document

This document is the **single source of truth for system architecture**. It defines *what
exists*, *what each part is responsible for*, *what it must never do*, and *how parts talk
to each other*. It deliberately stops short of implementation: no code, no SQL/Prisma, no
endpoint tables, no Dockerfiles, no prompt text.

Three words are used with strict meaning throughout:

| Word | Meaning |
| --- | --- |
| **MUST** | Non-negotiable. Violating it is an architecture breach and requires a change-control task (§27). |
| **SHOULD** | Strong default. Deviation requires a documented reason in the implementing phase's notes. |
| **MAY** | Genuinely optional; implementer's discretion within the surrounding contract. |

Anything described as *deferred*, *later*, or *out of scope for v1* is a conscious
architectural decision to postpone, not an omission to be quietly filled in by an
implementer.

---

## 1. Project vision

### 1.1 What this system is

An AI-powered **long-form narrative audio production platform**. It ingests a complete
book — PDF, EPUB, or scanned images — and produces a coherent, performed audiobook in
which the narrator sounds like one narrator, every character sounds like themselves from
chapter 1 to chapter 40, and delivery (emotion, pacing, pauses, emphasis) reflects what is
actually happening in the story.

### 1.2 What this system is not

It is **not** a PDF-to-TTS converter. A converter maps text spans to waveform. This system
maps **a book** to **a performance**. The distinction produces almost every architectural
decision below:

- Text extraction is a *low-level* concern, not the product.
- The TTS engine is a **dumb renderer**. It receives fully-decided performance instructions
  and never reads the book.
- All *understanding* happens upstream, is persisted, is versioned, and is reusable.
- Consistency across a 300,000-word artifact is a **state management** problem, not a
  prompt-engineering problem.

### 1.3 The canonical pipeline

```
Book
 → Ingestion            (accept, verify, store the raw artifact)
 → Parsing / OCR        (bytes → raw text + layout + reading order)
 → Normalization        (raw text → clean, canonical, de-noised text)
 → Structural Analysis  (canonical text → chapters / sections / paragraphs)
 → Narrative Understanding (structure → scenes, speakers, entities, events)
 → Story Bible          (persisted, incrementally-built narrative knowledge)
 → Character Registry   (stable identities + aliases + speech traits)
 → Voice Registry       (stable, versioned, approved voice profiles)
 → Audio Script IR      (Director output: the performance contract)
 → TTS Generation       (IR chunk → audio chunk, on GPU workers)
 → Audio Validation     (technical + optional content verification)
 → Chapter Assembly     (chunks → one chapter track)
 → Audiobook Assembly   (chapters → M4B/M4A with metadata + art)
 → Storage              (object storage, addressed by lineage)
 → Streaming / Download (authorized, signed, range-capable delivery)
```

Each arrow is a **boundary**: a stage consumes a persisted, addressable artifact produced
by the previous stage and produces a new persisted, addressable artifact. No stage reaches
backwards past its immediate input. This is what makes the pipeline resumable (§21) and
reproducible (§2.4).

### 1.4 Stage responsibilities and boundaries

| Stage | Responsibility | Explicit non-responsibility | Primary artifact produced |
| --- | --- | --- | --- |
| **Ingestion** | Accept upload, enforce size/MIME/format policy, compute content hash, persist original bytes to object storage, create `BookFile`. | Never parses, never reads content semantics. | `BookFile` + object key |
| **Parsing / OCR** | Bytes → text with layout, reading order, page/spine anchors, per-block confidence. Chooses digital-text vs OCR path. | Does not decide chapters, does not clean prose, does not interpret meaning. | `ParsedDocument` artifact (object storage) + provenance rows |
| **Normalization** | De-hyphenation, ligature repair, header/footer/page-number stripping, whitespace and quote canonicalization, encoding repair, footnote/endnote separation. | Does not summarize, does not rewrite the author's words, does not translate. | `CanonicalText` artifact + `content_hash` |
| **Structural Analysis** | Detect front/back matter, chapter boundaries, headings, section breaks, paragraph segmentation; build the reading spine. | Does not identify speakers or scenes. | `Chapter`, `Section`, `Paragraph` rows |
| **Narrative Understanding** | Scene segmentation, entity/speaker extraction, dialogue attribution candidates, POV detection, temporal/location cues. | Does not assign voices. Does not decide emotion delivery parameters. | `Scene` rows + Story Bible deltas |
| **Story Bible** | Persist and serve accumulated narrative knowledge; answer scoped context queries. | Is not an LLM. Does not generate. It is a **knowledge store with a retrieval API**. | `StoryBible`, `NarrativeState` |
| **Character Registry** | Own canonical character identity, aliases, pronouns, speech traits; resolve references → stable IDs. | Does not own voice timbre or TTS parameters. | `Character`, `CharacterAlias` |
| **Voice Registry** | Own voice profiles, versions, embeddings/reference audio, approval and lock state. | Does not decide *which line* a voice speaks. | `VoiceProfile`, `VoiceProfileVersion` |
| **Director** | Decide *how every span is performed*: speaker, emotion, intensity, pacing, pauses, emphasis, pronunciation, voice profile reference. Emit Audio Script IR. | **MUST NOT generate audio.** Does not own voice identity creation. Does not persist book structure. | `AudioScript`, `AudioScriptChunk` |
| **TTS Generation** | IR chunk + voice reference → audio bytes, deterministically parameterized. | **MUST NOT read the book, the Story Bible, or the Character Registry.** Does not decide emotion. | `AudioChunk` + object key |
| **Audio Validation** | Technical QC (duration, peak/clipping, silence, sample rate, corruption) and optional ASR content QC. | Does not fix audio; it *fails* or *flags*. | `ValidationReport` on the attempt |
| **Chapter Assembly** | Order chunks, apply pause plan, loudness-normalize, optional crossfade, render chapter track. | Does not re-generate chunks. | `ChapterAudio` |
| **Audiobook Assembly** | Concatenate chapters, write chapter markers, embed metadata + cover, encode final container. | Does not alter per-chapter audio content. | `Audiobook` |
| **Storage** | Durable, content-addressed persistence of all binary artifacts. | Holds no business logic. | object keys |
| **Delivery** | Authorized streaming (range requests) and download via short-lived signed URLs. | Does not transcode on the fly in v1. | signed URL / stream |

### 1.5 The six mandated separations

The system **MUST** keep these six concerns in distinct, independently-replaceable
components:

1. **Document understanding** — what the bytes say (Parser, Normalizer, Structural Analysis).
2. **Narrative understanding** — what the story means (Narrative Understanding, Story Bible, Character Registry).
3. **Voice assignment** — who sounds like what (Voice Registry, preview/approval workflow).
4. **Audio generation** — rendering instructions to waveform (TTS workers).
5. **Audio processing** — validating, normalizing, assembling (CPU audio workers).
6. **Delivery** — authorization, streaming, download.

A change in (4) — swapping XTTS for another engine — **MUST NOT** require changes in
(1), (2), (3), or (6). This is the load-bearing test of the whole design.

---

## 2. Architectural principles (non-negotiable)

### 2.1 Contract-first architecture

The documents in `docs/architecture/` are **authoritative**. Code conforms to documents;
documents do not get retro-fitted to code.

Implementation work **MUST NOT**:

- invent new architectural patterns,
- rename entities, fields, events, queues, or job types,
- redesign or "clean up" an API surface,
- change a database contract,
- substitute an infrastructure component,
- bypass a service boundary,

unless an explicit architecture-change task has been approved and the relevant document
updated first (§27). "The other way is cleaner" is not an approval.

### 2.2 Separation of concerns — the eight planes

| Plane | Contains | Concern |
| --- | --- | --- |
| **Control plane** | API Gateway, Auth, User, Book Service | Identity, authorization, resource lifecycle, request validation |
| **Intelligence plane** | Director, Narrative Understanding, Character, Story Bible/Context | Semantics, LLM interaction, narrative state |
| **Orchestration plane** | Job/Orchestration Service, schedulers, state machines | What runs, in what order, with what retry/recovery |
| **Compute plane** | Parser/OCR workers, Director workers, GPU TTS workers | Doing the expensive work |
| **Audio plane** | Validation, processing, chapter/audiobook assembly, encoding | Waveform-level correctness and craft |
| **Storage plane** | PostgreSQL, Redis, S3/MinIO | Durability, caching, ephemeral state |
| **Delivery plane** | Streaming, signed URLs, download, notifications | Getting artifacts to authorized humans |
| **Observability plane** | Logs, metrics, traces, alerting, cost accounting | Knowing what happened and what it cost |

A component belongs to exactly one plane. Cross-plane calls go through defined contracts
(HTTP for control, queues for compute, object keys for artifacts) — never through shared
mutable in-process state and never through a second service's private database tables.

### 2.3 Asynchronous-first processing

Any operation whose latency is unbounded, dependent on a model, or proportional to book
size **MUST** execute as a background job. HTTP handlers accept work, validate it,
persist intent, enqueue, and return a job handle. They do not wait.

Mandatorily asynchronous: parsing, OCR, normalization, structural analysis, narrative
analysis, all LLM inference, Director IR generation, all TTS inference, audio validation,
audio processing, chapter assembly, audiobook assembly, final encoding, ASR verification,
bulk exports.

Permitted synchronous work: authentication, authorization, CRUD on metadata, presigned
URL issuance, job status/progress reads, cursor-paginated list queries, single-item
lookups, and cancellation requests (which enqueue a cancel signal and return immediately).

**Hard rule:** no HTTP request handler may invoke an LLM, a TTS model, FFmpeg, or an OCR
engine inline. Not even "just for the small case."

### 2.4 Deterministic processing

Every meaningful artifact **MUST** carry a lineage record sufficient to explain and, where
the underlying model permits, reproduce it. The minimum lineage tuple for an audio chunk:

```
(source_content_hash,
 audio_script_ir_schema_version,
 director_version,          # prompt/logic/model bundle identity
 director_model_version,
 voice_profile_id,
 voice_profile_version,
 tts_provider_id,
 tts_model_version,
 generation_params_hash,    # seed, temperature, speed, sample rate, etc.
 pipeline_version)
```

Determinism is defined at two honest levels, because neural TTS is not bit-exact across
hardware:

- **Contract determinism (MUST):** identical lineage tuples MUST resolve to the *same
  stored artifact* — the system reuses it rather than regenerating. Regeneration is only
  triggered by a lineage change or an explicit force-regenerate request.
- **Model determinism (SHOULD):** where the engine supports seeding and deterministic
  kernels, workers SHOULD pin the seed and record it so that re-rendering yields
  perceptually identical audio. Bit-exactness across differing GPU models is **not**
  promised, and no component may depend on it.

Consequence: `generation_params_hash` and seed are first-class persisted fields, not
implementation trivia.

### 2.5 Immutable processing artifacts

Generated artifacts are **append-only**.

- An `AudioChunk`, once written, is never overwritten in place. Regeneration creates a
  **new** chunk row/version with its own lineage; the previous one is retained and marked
  superseded.
- Object storage keys embed identity + version, so a key is never rewritten with different
  bytes.
- `VoiceProfileVersion` rows are immutable once used by any generated audio (§9).
- `AudioScriptChunk` becomes immutable once TTS generation has started against it (§7.3).
- Deletion is a *lifecycle/retention* operation (explicit, audited, user- or policy-driven),
  never a side effect of a rerun.

Rationale: an audiobook is a compound artifact assembled from thousands of pieces over
hours or days. Without immutability, partial reruns silently produce Frankenstein output
whose provenance can no longer be established.

---

## 3. System architecture

### 3.1 Service inventory and deployment posture

Logical boundaries are defined now; physical process boundaries are introduced only where
they buy independent scaling, independent failure, or a hard runtime difference (GPU,
Python ML stack). Microservices are not a goal.

**v1 deployable units** (five processes, not fifteen):

| Deployable unit | Runtime | Contains (logical services) |
| --- | --- | --- |
| **`web`** | Next.js / Node | Frontend app + BFF calls to `api` |
| **`api`** | Node/TypeScript | API Gateway, Auth, User, Book, Ingestion, Character, Voice, Story Bible/Context API, Job/Orchestration API, Notification |
| **`worker-cpu`** | Node/TypeScript + Python sidecars via subprocess or a small internal service | Parser/OCR orchestration, Normalization, Structural Analysis, Audio Validation, Audio Processing, Chapter/Audiobook Assembly (FFmpeg) |
| **`worker-ai`** | Python (FastAPI-shaped internal service + queue consumer) | Narrative Understanding, Director, Story Bible enrichment — all LLM-facing work |
| **`worker-gpu`** | Python + CUDA | TTS Service (TTSProvider implementations), speaker embedding, optional ASR verification |

Each logical service keeps its own module boundary, its own schema ownership, and
communicates only via its published contract, so any of them can be extracted into its own
process later **without a contract change**. Extraction is a deployment change, not an
architecture change.

Rules that make later extraction cheap and are therefore **MUST** from day one:

1. Only the owning service writes to its owned tables (§4.2). Other services read via that
   service's API/module interface, never by joining across ownership boundaries.
2. All cross-service async communication goes through named queues and named events
   (§11), never in-process function calls that assume co-location.
3. No shared mutable module-level state between logical services.

### 3.2 Service specifications

Format per service: **Responsibility / Non-responsibilities / Inputs / Outputs /
Dependencies / Persistent data / Sync ops / Async ops / Failure behavior / Scaling.**

---

#### 3.2.1 API Gateway

- **Responsibility:** single external ingress. TLS termination, routing, request
  validation (shape only), authentication verification, rate limiting, request ID and
  trace context injection, response envelope enforcement, CORS.
- **Non-responsibilities:** no business logic, no direct DB access, no queue publishing of
  domain jobs (it forwards to owning services), no LLM/TTS calls.
- **Inputs:** external HTTP requests, JWT/session credentials.
- **Outputs:** routed internal calls; normalized error envelope (§25.6).
- **Dependencies:** Auth Service (token verification), Redis (rate-limit counters).
- **Persistent data:** none (Redis counters only).
- **Sync:** all of it.
- **Async:** none.
- **Failure:** fail fast, `503` with `Retry-After` on downstream unavailability; never
  queue on behalf of a downed service.
- **Scaling:** stateless horizontal.

#### 3.2.2 Auth Service

- **Responsibility:** identity verification, credential handling, session/token issuance
  and rotation, refresh, revocation, MFA hooks, service-to-service token minting.
- **Non-responsibilities:** does not own user profile data; does not make resource-level
  authorization decisions (it supplies the principal; owning services enforce ownership).
- **Inputs:** credentials, refresh tokens, OAuth/OIDC callbacks (if enabled).
- **Outputs:** access tokens with `{sub, tenant_id, roles, scopes, exp}`; revocation events.
- **Dependencies:** PostgreSQL (credentials), Redis (revocation list, rate limits).
- **Persistent data:** credential records, sessions, refresh tokens, revocations.
- **Sync:** login, refresh, logout, token introspection.
- **Async:** `user.registered` / `auth.password_reset_requested` events → Notification.
- **Failure:** authentication failures are terminal and never retried by the caller; token
  verification MUST fail closed.
- **Scaling:** stateless horizontal; token verification cached in Redis with short TTL.

#### 3.2.3 User Service

- **Responsibility:** user/tenant profile, preferences, quotas and usage counters,
  entitlement checks, project/workspace membership.
- **Non-responsibilities:** no credentials, no book data.
- **Inputs:** authenticated principal, profile mutations, usage increments from workers.
- **Outputs:** profile records, quota decisions.
- **Dependencies:** PostgreSQL, Auth (principal).
- **Persistent data:** `User`, tenant/project, quota and usage aggregates.
- **Sync:** profile CRUD, quota check.
- **Async:** usage roll-ups; quota-exceeded notifications.
- **Failure:** quota check unavailable → fail closed for *new expensive work*, fail open for
  reads.
- **Scaling:** stateless horizontal.

#### 3.2.4 Book Service

- **Responsibility:** the `Book` aggregate root and its structural children (`Chapter`,
  `Section`, `Paragraph`); book-level lifecycle state; ownership; the read model that the
  UI and Director consume for structure.
- **Non-responsibilities:** does not parse, does not analyze narrative, does not own audio.
- **Inputs:** book creation requests, parser/structural-analysis results (via events).
- **Outputs:** book metadata, reading spine, structural read models, `book.*` events.
- **Dependencies:** PostgreSQL, Object Storage (references only), Job Service.
- **Persistent data:** `Book`, `Chapter`, `Section`, `Paragraph` (owner).
- **Sync:** CRUD, structure reads, progress summary.
- **Async:** consumes `book.parsed`, `book.structure_ready`; emits `book.*`.
- **Failure:** structural ingest is idempotent per `(book_id, pipeline_version,
  content_hash)`; conflicting structure versions are stored side-by-side, never merged.
- **Scaling:** stateless horizontal; read-heavy endpoints cached in Redis.

#### 3.2.5 Ingestion Service

- **Responsibility:** upload lifecycle — presigned/multipart upload issuance, size and
  MIME enforcement, magic-byte sniffing, extension/type agreement, hashing, virus/malware
  scan hook, quarantine, `BookFile` creation, deduplication by content hash.
- **Non-responsibilities:** never opens the document with a parsing library; never trusts
  client-declared content type.
- **Inputs:** upload requests, object-storage completion callbacks.
- **Outputs:** `BookFile` rows, `book.uploaded` event, quarantine decisions.
- **Dependencies:** Object Storage, PostgreSQL, Redis (upload session), Job Service.
- **Persistent data:** `BookFile` (owner), upload sessions (Redis, TTL'd).
- **Sync:** issue upload URL, finalize upload, report upload state.
- **Async:** hashing of large objects, malware scan, `book.uploaded` emission.
- **Failure:** incomplete uploads expire and are garbage-collected; failed validation moves
  the object to a quarantine prefix and marks `BookFile.status = REJECTED` with a reason
  code. Rejection is terminal and non-retryable without a new upload.
- **Scaling:** stateless horizontal; bytes flow client↔object-storage directly, never
  through the service.

#### 3.2.6 Parser Service (Parsing / OCR / Normalization)

- **Responsibility:** route by format (PDF-digital, PDF-scanned, EPUB, images), extract
  text with layout and reading order, run OCR where needed, emit per-block confidence,
  normalize to canonical text, compute `content_hash`, produce the `ParsedDocument` and
  `CanonicalText` artifacts. Also runs structural analysis (chapters/sections/paragraphs).
- **Non-responsibilities:** no narrative interpretation, no speaker attribution, no voice
  concerns, no LLM-based rewriting of the author's prose.
- **Inputs:** `BookFile` object key, format hints, OCR language hints.
- **Outputs:** parsed + canonical artifacts in object storage; structure rows for Book
  Service; `book.parsed`, `book.structure_ready` events; per-block confidence report.
- **Dependencies:** Object Storage, PostgreSQL, Queue, OCR engine, Marker (or equivalent).
- **Persistent data:** parse artifacts (object storage), parse provenance rows, `ModelVersion`
  references for OCR/parser versions.
- **Sync:** none beyond status reads.
- **Async:** `parse_book`, `ocr_pages`, `normalize_text`, `analyze_structure`.
- **Failure:** per-page isolation — a failed page is recorded, retried, and if still failing
  is marked `NEEDS_REVIEW` without failing the whole book. Low-confidence OCR regions
  surface to the user rather than silently entering the pipeline.
- **Scaling:** CPU horizontal; OCR is the bottleneck and is parallelized per page/shard.

#### 3.2.7 Director Service

- **Responsibility:** the intelligence layer that converts structured text + retrieved
  narrative context into **Audio Script IR** (§6, §7). Speaker attribution resolution
  (with Character Service), emotion/pacing/prosody decisions, pause planning, emphasis,
  pronunciation hints, voice profile binding.
- **Non-responsibilities:** **MUST NOT generate audio.** Does not create characters
  autonomously without the Character Service's identity contract. Does not own book
  structure. Does not own voice timbre.
- **Inputs:** `Chapter`/`Scene`/`Paragraph` text, Story Bible context bundle (§5.4),
  Character Registry resolutions, Voice Registry bindings, Director version config.
- **Outputs:** `AudioScript` + `AudioScriptChunk` rows, Story Bible deltas, `director.*`
  events, validation reports.
- **Dependencies:** Context Service, Character Service, Voice Service, LLM runtime, Queue,
  PostgreSQL.
- **Persistent data:** `AudioScript`, `AudioScriptChunk` (owner), Director run records.
- **Sync:** dry-run / preview of a single chunk (bounded, rate-limited, for the UI only).
- **Async:** `analyze_scene`, `generate_director_ir`, `revise_director_ir`.
- **Failure:** malformed LLM output → schema-repair pass → bounded retry with reduced
  context → escalate to `NEEDS_REVIEW` with a deterministic fallback IR (narrator voice,
  neutral emotion) rather than blocking the book. Fallbacks are flagged, never silent.
- **Scaling:** horizontal, bounded by LLM throughput; concurrency capped per book to
  preserve sequential context accumulation ordering (§5.5).

#### 3.2.8 Character Service (Character Registry)

- **Responsibility:** canonical character identity for a book: `Character`,
  `CharacterAlias`, pronouns, speech traits, first/last appearance, merge/split of
  identities, and the **reference-resolution contract** (§8).
- **Non-responsibilities:** does not choose voices; does not decide per-line emotion.
- **Inputs:** extraction candidates from Narrative Understanding/Director, user edits,
  merge/split commands.
- **Outputs:** stable `character_id`s, alias tables, resolution responses, `character.*`
  events.
- **Dependencies:** PostgreSQL, Story Bible, Queue.
- **Persistent data:** `Character`, `CharacterAlias` (owner).
- **Sync:** resolve reference → character ID (must be fast; cached), character CRUD, merge.
- **Async:** bulk re-resolution after a merge/split, alias mining.
- **Failure:** unresolved reference resolves to the reserved `UNKNOWN_SPEAKER` sentinel and
  raises a review item; it never guesses silently and never invents a new character to
  avoid an error.
- **Scaling:** stateless horizontal; resolution index cached per book in Redis.

#### 3.2.9 Voice Service (Voice Registry)

- **Responsibility:** voice profiles and their immutable versions, reference audio /
  speaker embeddings, model+language+parameter binding, approval and lock state, character
  ↔ voice assignment, preview sample lifecycle (§9, §15).
- **Non-responsibilities:** does not synthesize audio itself (it *requests* TTS for
  previews); does not decide emotion.
- **Inputs:** voice creation/assignment requests, reference audio uploads, approval
  actions, preview results.
- **Outputs:** `VoiceProfile`, `VoiceProfileVersion`, resolved voice bindings for the
  Director, `voice.*` events.
- **Dependencies:** Object Storage (reference audio, previews), PostgreSQL, Queue, TTS
  Service (for previews).
- **Persistent data:** `VoiceProfile`, `VoiceProfileVersion` (owner), assignments.
- **Sync:** list/assign/approve/lock, resolve `(book, character) → voice_profile_version`.
- **Async:** preview sample generation, embedding extraction.
- **Failure:** a locked/used version can never be mutated; attempts return a contract
  error directing the caller to create a new version.
- **Scaling:** stateless horizontal; resolution cache in Redis, invalidated on version events.

#### 3.2.10 Context / Story Bible Service

- **Responsibility:** persist accumulated narrative knowledge and **serve bounded,
  ranked context bundles** for a given Director request (§5). Owns `StoryBible` and
  `NarrativeState`. Applies deltas produced by Narrative Understanding/Director.
- **Non-responsibilities:** is not an LLM; performs no generation; makes no performance
  decisions.
- **Inputs:** narrative deltas, context queries `(book, chapter, scene, chunk, budget)`.
- **Outputs:** context bundles with a token budget and provenance; `NarrativeState`
  snapshots.
- **Dependencies:** PostgreSQL (+ vector index), Redis (hot context cache), Object Storage
  (large summaries).
- **Persistent data:** `StoryBible`, `NarrativeState` (owner), embeddings/index.
- **Sync:** context retrieval (must be fast — it is on the Director's critical path).
- **Async:** delta application, summary rollups, re-embedding, index maintenance.
- **Failure:** on partial retrieval failure it returns a **degraded bundle** explicitly
  marked `degraded=true` with the missing layers named; the Director MUST treat a degraded
  bundle as a lower-confidence run and flag its output.
- **Scaling:** read-heavy horizontal; snapshotting is the write bottleneck and is serialized
  per book.

#### 3.2.11 Job / Orchestration Service

- **Responsibility:** the state machine (§16) for all `ProcessingJob`s and
  `ProcessingAttempt`s; dependency/DAG sequencing per book; enqueueing; priority; progress
  aggregation; cancellation; resumption; dead-letter handling; idempotency-key registry.
- **Non-responsibilities:** does not perform domain work; does not know how to parse or
  synthesize anything.
- **Inputs:** job requests from services, worker heartbeats/completions, cancel requests.
- **Outputs:** queue messages, job state transitions, `job.*` events, progress read models.
- **Dependencies:** Redis/BullMQ, PostgreSQL, all workers.
- **Persistent data:** `ProcessingJob`, `ProcessingAttempt` (owner), idempotency keys.
- **Sync:** create job (returns handle), read status/progress, cancel.
- **Async:** everything else.
- **Failure:** it is the **authority on truth for job state**; queue state is a cache of it.
  On Redis loss, jobs are rebuilt from PostgreSQL (§21). Orphaned `RUNNING` jobs past
  heartbeat deadline are reaped to `RETRYING` or `FAILED`.
- **Scaling:** horizontal; per-book sequencing enforced via Redis locks keyed on `book_id`.

#### 3.2.12 TTS Service (GPU workers)

- **Responsibility:** consume `generate_tts_chunk` jobs, load/keep the right model and
  voice reference, synthesize audio for one IR chunk, write bytes to object storage,
  record lineage, report duration/technical metrics. Implements the `TTSProvider`
  interface (§10).
- **Non-responsibilities:** **MUST NOT** read the book, Story Bible, or Character Registry.
  **MUST NOT** decide emotion, speaker, or voice — those arrive fully decided in the IR.
- **Inputs:** `AudioScriptChunk` (self-sufficient), resolved `VoiceProfileVersion`
  reference (embedding or reference-audio object key), generation params + seed.
- **Outputs:** `AudioChunk` + object key + technical metadata; `tts.*` events.
- **Dependencies:** Object Storage, Queue, PostgreSQL (writes chunk rows via a narrow
  contract), GPU.
- **Persistent data:** `AudioChunk` (owner).
- **Sync:** health/capability report (`/capabilities`: models, versions, VRAM, max batch).
- **Async:** all synthesis, including preview samples.
- **Failure:** OOM → shrink batch → retry → route to a smaller-model/CPU fallback lane only
  if configured; otherwise fail the chunk (not the chapter) and let §16 recovery handle it.
- **Scaling:** independently horizontal on GPU nodes (§20). Chunk-level parallelism is the
  primary throughput lever.

#### 3.2.13 Audio Processing Service

- **Responsibility:** technical validation (§14.3), loudness normalization to target LUFS,
  peak limiting, silence trimming/insertion per the IR pause plan, optional crossfade,
  resampling, format conversion.
- **Non-responsibilities:** does not re-generate audio; does not alter the performance
  decisions; does not assemble the book.
- **Inputs:** `AudioChunk` object keys + IR pause metadata.
- **Outputs:** processed chunk artifacts, `ValidationReport`, `audio.validated` events.
- **Dependencies:** FFmpeg, Object Storage, Queue.
- **Persistent data:** validation reports and processed-artifact rows (new versions, never
  overwrites).
- **Async:** `validate_audio`, `process_audio`.
- **Failure:** validation failure marks the chunk `INVALID` with a reason code and requests
  regeneration of **that chunk only**.
- **Scaling:** CPU horizontal; cheap and highly parallel.

#### 3.2.14 Audio Assembly Service

- **Responsibility:** deterministic ordering and concatenation of validated chunks into
  `ChapterAudio`; chapters into `Audiobook`; chapter markers, metadata, cover art, final
  encoding (M4B/M4A/MP3), duration index for streaming.
- **Non-responsibilities:** no generation, no per-chunk DSP beyond join-level crossfade.
- **Inputs:** ordered validated chunk keys, chapter metadata, book metadata, cover image.
- **Outputs:** `ChapterAudio`, `Audiobook`, chapter marker index, `chapter.completed`,
  `audiobook.completed`.
- **Dependencies:** FFmpeg, Object Storage, PostgreSQL, Queue.
- **Persistent data:** `ChapterAudio`, `Audiobook` (owner).
- **Async:** `assemble_chapter`, `assemble_audiobook`.
- **Failure:** assembly is a **pure function of its inputs** and is always safe to re-run;
  it refuses to run on an incomplete chunk set unless explicitly asked for a partial
  preview build (which is marked as such and never published as the final artifact).
- **Scaling:** CPU horizontal; I/O bound on object storage.

#### 3.2.15 Notification Service

- **Responsibility:** fan-out of user-facing events — email, in-app, webhook, and
  server-sent progress streams; user notification preferences; delivery retry.
- **Non-responsibilities:** no domain logic; never the source of truth for job state.
- **Inputs:** domain events (§11.3).
- **Outputs:** delivered notifications; SSE/WebSocket progress streams.
- **Dependencies:** Queue, Redis (pub/sub for live progress), email/webhook providers.
- **Persistent data:** notification log, preferences.
- **Async:** all delivery.
- **Failure:** at-least-once delivery with dedupe key; permanent failures logged, never
  retried indefinitely; notification failure MUST NOT affect pipeline state.
- **Scaling:** stateless horizontal.

### 3.3 Services deliberately *not* created in v1

| Not created | Why | Where it lives instead |
| --- | --- | --- |
| Separate Ingestion vs Book service processes | Same aggregate lifecycle, same scaling profile | `api` |
| Separate Normalization service | Always runs with parsing, same runtime | Parser Service |
| Separate Narrative Understanding service | Same LLM runtime and scaling profile as Director | `worker-ai`, distinct module + distinct job types |
| Search service | No cross-book search requirement in v1 | Deferred |
| Billing service | No monetization in v1; usage counters only | User Service (usage), deferred |
| Kafka / event bus service | See §11.1 | Redis Streams/BullMQ events |

---

## 4. Data architecture (conceptual)

This section defines **entities, meaning, relationships, lifecycle, ownership,
immutability, and versioning**. It does **not** define columns, types, indexes, or Prisma
models. `docs/architecture/database-schema.md` derives the physical schema from this
section and may not introduce entities absent here without a change-control task (§27).

### 4.1 Cross-cutting rules

- **Tenancy:** every user-owned entity carries `tenant_id` (and, where applicable,
  `project_id`) — see §19. There are no globally-visible user artifacts.
- **Identity:** opaque, non-sequential IDs (UUIDv7 or ULID) for all entities. IDs never
  encode meaning; sort order is not semantic.
- **Timestamps:** `created_at`, `updated_at` on all rows; UTC only.
- **Soft delete:** user-facing entities are soft-deleted with `deleted_at`; generated
  artifacts are retained until a retention policy or explicit purge removes them.
- **Content addressing:** any entity derived from text carries the `content_hash` of that
  text. Any entity derived from a model carries the relevant `ModelVersion` reference.
- **Ownership:** exactly one service writes each entity (table below). Everyone else reads
  through that service.

### 4.2 Entity catalogue

Legend — **Mut.**: `M` mutable, `I` immutable once created, `I*` immutable once *used*.
**Ver.**: whether the entity is explicitly versioned.

| # | Entity | Purpose | Owner service | Mut. | Ver. |
| --- | --- | --- | --- | --- | --- |
| 1 | `User` | Principal + tenant/project membership, preferences, quotas | User | M | no |
| 2 | `Book` | Aggregate root for one work; lifecycle state; metadata (title, author, language) | Book | M | pipeline-versioned |
| 3 | `BookFile` | One uploaded source artifact (PDF/EPUB/image set); object key; hash; MIME; scan status | Ingestion | I | no (new upload = new row) |
| 4 | `Chapter` | Ordered structural division of the reading spine; title; order index | Book | M | structure-versioned |
| 5 | `Section` | Sub-chapter division (part, numbered section, scene break group) | Book | M | structure-versioned |
| 6 | `Scene` | Narrative unit within a chapter: continuous time/place/participants | Book (rows) / Story Bible (semantics) | M | structure-versioned |
| 7 | `Paragraph` | Smallest canonical text unit with stable order + `content_hash` | Book | I* | structure-versioned |
| 8 | `Character` | Canonical identity within a book; includes `NARRATOR` and `UNKNOWN_SPEAKER` sentinels | Character | M | no |
| 9 | `CharacterAlias` | A surface form (name, nickname, title, epithet, pronoun-scope) → character | Character | M | no |
| 10 | `VoiceProfile` | Named voice concept ("Alice", "Narrator"), owns its version chain, lock state | Voice | M | yes (via versions) |
| 11 | `VoiceProfileVersion` | Concrete, renderable voice: model, language, embedding/reference key, params, approval | Voice | I* | yes |
| 12 | `StoryBible` | Per-book knowledge container: entities, relationships, locations, timeline, objects, factions, motifs | Context | M (append-preferred) | snapshot-versioned |
| 13 | `NarrativeState` | Point-in-time narrative state at a spine position (open threads, present characters, mood, POV) | Context | I (snapshot) | yes |
| 14 | `AudioScript` | Director run output for a scope (book/chapter); holds Director version + config | Director | I | yes |
| 15 | `AudioScriptChunk` | One renderable performance unit (§7) | Director | I* | yes (schema + director version) |
| 16 | `TTSJob` | A synthesis request for one chunk + its parameters and target provider | Job / TTS | I | no |
| 17 | `AudioChunk` | Rendered audio for one IR chunk; object key; duration; technical metrics; lineage | TTS | I | yes (supersede chain) |
| 18 | `ChapterAudio` | Assembled chapter track; ordered chunk manifest; duration; loudness stats | Assembly | I | yes |
| 19 | `Audiobook` | Final deliverable; chapter manifest; container format; metadata; cover | Assembly | I | yes |
| 20 | `ProcessingJob` | Logical unit of async work with state machine (§16), idempotency key, priority | Job | M (state only) | no |
| 21 | `ProcessingAttempt` | One execution of a job: worker, timings, outcome, error, resource usage | Job | I | no |
| 22 | `ModelVersion` | Registry of every model/tool identity used (OCR, LLM, TTS, ASR) + params fingerprint | Job/Platform | I | yes |

### 4.3 Relationships (conceptual)

```
User ─1:N─ Book ─1:N─ BookFile
Book ─1:N─ Chapter ─1:N─ Section ─1:N─ Scene ─1:N─ Paragraph
Book ─1:N─ Character ─1:N─ CharacterAlias
Book ─1:1─ StoryBible ─1:N─ NarrativeState (snapshots along the spine)
Book ─1:N─ VoiceProfile ─1:N─ VoiceProfileVersion
Character ─N:1─ VoiceProfile            (assignment, scoped to a book)
Book ─1:N─ AudioScript ─1:N─ AudioScriptChunk
AudioScriptChunk ─1:N─ TTSJob ─1:1─ AudioChunk     (N attempts, one current)
AudioChunk ─N:1─ ChapterAudio ─N:1─ Audiobook
ProcessingJob ─1:N─ ProcessingAttempt
ModelVersion ← referenced by AudioScript, AudioChunk, VoiceProfileVersion, parse artifacts
```

Notes on cardinality that matter architecturally:

- `AudioScriptChunk → AudioChunk` is 1:N over time (regeneration), with exactly one chunk
  marked `current`. Superseded chunks are retained.
- `Character → VoiceProfile` is many-to-one *per book* (two minor characters may
  intentionally share a profile), but a `Character` has exactly one **active** assignment
  at a time.
- `Scene` spans paragraphs and may cross a `Section` boundary but **never** a `Chapter`
  boundary in v1 (simplifying constraint; revisit under change control if a book demands it).

### 4.4 Lifecycles

**Book:** `CREATED → UPLOADED → PARSING → PARSED → STRUCTURED → ANALYZING → ANALYZED →
CASTING (voice preview/approval) → SCRIPTING (Director) → SCRIPTED → GENERATING →
ASSEMBLING → COMPLETED`, with `FAILED`, `CANCELLED`, and `NEEDS_REVIEW` as
cross-cutting states reachable from any active state. `NEEDS_REVIEW` is *not* terminal —
it awaits a human decision and returns to the pipeline.

**AudioScriptChunk:** `DRAFT → VALIDATED → LOCKED (generation started) → SUPERSEDED`.

**VoiceProfileVersion:** `DRAFT → PREVIEW_GENERATED → APPROVED → LOCKED (used in output) →
RETIRED`. A `LOCKED` version is immutable forever; `RETIRED` means "no longer selectable
for new assignments" and never means "deleted."

**AudioChunk:** `PENDING → GENERATING → GENERATED → VALIDATED → (ASSEMBLED) →
SUPERSEDED?` with `FAILED`/`INVALID` branches feeding regeneration.

### 4.5 Immutability and versioning requirements

| Requirement | Applies to |
| --- | --- |
| Never mutate after creation | `BookFile`, `ProcessingAttempt`, `NarrativeState`, `AudioChunk`, `ChapterAudio`, `Audiobook`, `ModelVersion` |
| Never mutate after first use | `Paragraph` (once scripted), `AudioScriptChunk` (once generation starts), `VoiceProfileVersion` (once any audio generated) |
| Version chain with explicit supersede pointer | `AudioChunk`, `AudioScriptChunk`, `VoiceProfileVersion`, `ChapterAudio`, `Audiobook`, `StoryBible` snapshots |
| Carries full lineage tuple (§2.4) | `AudioChunk`, `ChapterAudio`, `Audiobook` |
| Carries `content_hash` of source text | `Paragraph`, `AudioScriptChunk`, `AudioChunk` |

---

## 5. Story Bible architecture

### 5.1 Purpose

A book is far larger than any usable context window, and narrative meaning is
*cumulative*: who "he" is in chapter 12 depends on chapter 11; whether a line is bitter or
fond depends on a betrayal 200 pages earlier. The Story Bible is the **persistent memory**
that makes chapter 40 as well-informed as chapter 2, without re-reading the book.

The Story Bible is a **knowledge store with a retrieval API**. It does not think. It is
written by the Narrative Understanding and Director stages and read by the Director.

### 5.2 What it tracks

| Domain | Contents |
| --- | --- |
| **Characters** | canonical identity, aliases, role, importance rank, first/last appearance, arc summary |
| **Speech characteristics** | register, verbosity, dialect/accent notes, catchphrases, formality, typical emotional baseline, age/gender presentation cues **as stated or strongly implied by the text** |
| **Relationships** | typed, directional, time-scoped edges (`ALICE →protects→ BEN`, from ch.3) |
| **Personality** | traits with textual evidence pointers |
| **Narrative perspective** | POV type (1st/3rd-limited/omniscient), POV holder per chapter/scene, tense, reliability notes, multiple-narrator map |
| **Locations** | places, containment hierarchy, atmosphere descriptors |
| **Timeline** | ordered events, in-story time markers, flashback/flash-forward spans |
| **Objects** | plot-significant items and their custody chain |
| **Factions** | groups, allegiances, conflicts |
| **Scenes** | boundaries, participants, location, time, mood, tension level, summary |
| **Unresolved state** | open questions, secrets known to which characters, dramatic irony, foreshadowing awaiting payoff |
| **Current scene context** | rolling working set at the current spine position |
| **Pronunciation lexicon** | book-scoped canonical pronunciations for names, places, invented words (§6.4) |

Every fact carries **provenance**: the paragraph/scene range it came from, the extracting
model version, and a confidence score. Facts without provenance are not admissible.

### 5.3 Storage model

- Structured facts and relationships → PostgreSQL (relational + JSONB for typed attribute
  bags). Queryable, joinable, auditable.
- Semantic recall of prose-level detail → vector index over scene/paragraph summaries
  (pgvector in v1; a dedicated vector store only if scale demands it — change control).
- Long summaries and derived documents → object storage, referenced by key.
- Hot working set for the book currently being scripted → Redis, TTL'd, rebuildable.

`NarrativeState` snapshots are written at **scene boundaries** (and at chapter boundaries
as a coarser checkpoint). A snapshot is an immutable point-in-time view: which characters
are present, what the POV is, what is unresolved, what the emotional register is. Snapshots
are what make the Director resumable mid-book without replaying everything.

### 5.4 Context retrieval — the six-layer bundle

**A Director request MUST NOT include the whole book, the whole Story Bible, or the whole
chapter's raw text.** Context is assembled by the Context Service as a bounded,
prioritized bundle:

| Layer | Content | Typical budget share | Eviction priority |
| --- | --- | --- | --- |
| **L1 — Global book context** | Genre, tone, POV type, narrator identity, target audience, style guide, global pronunciation rules | ~5% | last (never evicted) |
| **L2 — Character context** | Only characters *present or referenced* in this window: identity, aliases, speech traits, active relationships, current emotional stance | ~20% | high value, evicted by importance rank |
| **L3 — Chapter context** | Chapter summary so far, chapter POV, chapter-level open threads | ~10% | medium |
| **L4 — Scene context** | Current scene: participants, location, time, mood, tension, scene summary | ~15% | high value |
| **L5 — Adjacent narrative context** | Verbatim tail of the preceding chunk(s) and head of the following chunk, plus the last N attributed dialogue turns with their speakers | ~20% | high value (attribution depends on it) |
| **L6 — Current chunk** | The text to be directed, verbatim, never truncated | remainder (~30%) | never evicted |

Rules:

1. **L6 is inviolable.** If the bundle does not fit, the *chunk is split*, never truncated.
2. The bundle is assembled against an explicit **token budget** derived from the configured
   LLM's context window minus a reserved output allowance and a safety margin.
3. Retrieval is **hybrid**: deterministic structural lookup (this scene's participants,
   this chapter's summary) plus semantic search (pgvector) for "what else is relevant."
   Structural results always outrank semantic results.
4. Every bundle carries a **provenance manifest** — which facts, from which snapshot, at
   which versions — and is hashed. The hash participates in the Director run's lineage so a
   given IR is explainable.
5. Bundles are **cacheable** by `(book_id, spine_position, story_bible_snapshot_version,
   budget, director_version)`.
6. If a layer cannot be retrieved, the bundle is returned `degraded=true` naming the missing
   layers, and the resulting IR is flagged low-confidence (§3.2.10).

### 5.5 Incremental accumulation and ordering

Narrative context accumulates **in reading order**. The system therefore enforces:

- **Sequential analysis within a book:** narrative-understanding and Director jobs for a
  given book advance in spine order; per-book concurrency is capped and guarded by a Redis
  lock keyed on `book_id` (§11.5). Chunks *within an already-analyzed scene* may be
  directed in parallel, because their context bundle is already fixed.
- **Snapshot-then-fan-out:** once a scene's `NarrativeState` snapshot exists, all chunks in
  that scene are independent and parallelizable. This is where throughput comes from.
- **Two-pass option (v1.1, deferred):** a cheap fast pass over the whole book to seed the
  Story Bible with the cast and structure, then a rich sequential pass. Architecture must
  not preclude it — hence Story Bible snapshots are versioned and re-derivable.

### 5.6 Context-window limitation strategy (explicit)

- Chunk sizing targets a **performance-natural unit** (a paragraph, or a dialogue exchange),
  bounded by an absolute character ceiling and by the TTS engine's practical input limit —
  whichever is smaller. Chunk boundaries **MUST** align to sentence boundaries.
- Summaries are **hierarchical**: paragraph → scene → chapter → act/part → book. Higher
  levels are regenerated when lower levels change, and each carries the version of the
  content it summarizes.
- Character context is **ranked and capped**: importance rank × recency × presence-in-window.
- The system never relies on the LLM "remembering" anything between calls. Every call is
  stateless and fully specified by its bundle. Statefulness lives in PostgreSQL.

---

## 6. Director layer

### 6.1 Definition

The Director is the **semantic orchestration layer** that stands between narrative
understanding and audio generation. It answers exactly one question, for every span of the
book: *how should this be performed?*

It is the only component permitted to make performance decisions, and it is forbidden from
executing them.

### 6.2 Decisions the Director makes

For each chunk:

| Decision | Notes |
| --- | --- |
| `speaker_type` | `NARRATOR` \| `CHARACTER` \| `UNKNOWN` \| `SYSTEM` (headings, front matter, footnotes) |
| `character_id` | Stable ID from Character Registry; `NARRATOR`/`UNKNOWN_SPEAKER` sentinels allowed |
| `is_dialogue` | Dialogue vs narration vs internal thought (distinct, not a boolean pair) |
| `delivery_mode` | `NORMAL` \| `INTERNAL_THOUGHT` \| `WHISPER` \| `SHOUT` \| `LAUGHING` \| `CRYING` \| `SINGING` \| `READING_ALOUD` (letter/sign/inscription) |
| `emotion` | Closed vocabulary (§6.3) |
| `intensity` | 0.0–1.0, quantized to a documented step |
| `pacing` | Relative speech rate multiplier within a bounded range |
| `volume` | Relative gain hint within a bounded range |
| `pitch` | Relative pitch hint within a bounded range |
| `pauses` | Structured pause plan: leading, trailing, and intra-text at character offsets, in ms |
| `emphasis` | Spans (offset, length, strength) — never raw markup embedded in text |
| `pronunciation` | Span-scoped hints referencing the book pronunciation lexicon |
| `scene_ref` | Scene ID for traceability |
| `voice_profile_ref` | `(voice_profile_id, voice_profile_version)` resolved at IR generation time |
| `confidence` | Per-decision confidence, driving review queues |

### 6.3 Closed vocabularies

Emotion and delivery mode **MUST** be closed enumerations defined in
`docs/architecture/director-specification.md`. Rationale:

> **Correction (architecture-review.md §3, §56; `audio-script-ir.md` IR-7; `director-specification.md`
> DIR-1).** This section previously included pacing among the closed enumerations. Pacing is,
> and was always meant to be, a **bounded numeric multiplier** (§6.2, §7.2 of this document;
> `api-specification.md` §12.3; `database-schema.md` §5.5; `audio-script-ir.md` §19.2), not an
> enumeration — a relative speech-rate value cannot be a member of a closed vocabulary. Every
> downstream document that implements pacing correctly treated it as numeric and flagged this
> sentence as the defect (five independent sources agreeing against this one); the wording is
> now corrected to match the numeric treatment `director-specification.md` §4.3 fixes
> authoritatively (bounds `[0.50, 2.00]`, baseline `1.00`, quantization step `0.01`). Pitch and
> volume are likewise numeric and were never listed here as enumerations. No implementation
> impact: this closes a documentation-only self-contradiction within this document; nothing
> that reads pacing as numeric changes.

- An open vocabulary makes IR unvalidatable and cross-engine mapping impossible.
- Every TTS provider maps the *same* closed vocabulary to its own control surface (§10.3);
  an unmapped value is a provider-implementation gap, not a data problem.
- The LLM's output is validated against the enumeration; out-of-vocabulary values are a
  validation failure with a repair pass, never a pass-through.

The Director emits **semantic intent** (`emotion=grief, intensity=0.7`), not engine
parameters. Translation to engine controls happens inside the provider adapter. This is the
single most important boundary in §10.

### 6.4 Pronunciation

Two tiers:

1. **Book lexicon** (Story Bible): canonical pronunciation of proper nouns and invented
   words, established once, applied everywhere, user-editable. Stored phonetically in a
   documented notation (IPA canonical, engine-specific forms derived by the adapter).
2. **Span hints** (IR): contextual disambiguation ("lead" the metal vs the verb), attached
   as offset-scoped annotations.

Pronunciation **MUST NOT** be encoded by mangling the display text. The text field stays
faithful to the book; hints are separate, offset-addressed metadata.

### 6.5 What the Director must not do

- **MUST NOT** synthesize, decode, or touch audio.
- **MUST NOT** create voice profiles or alter voice identity.
- **MUST NOT** rewrite, abridge, or paraphrase the author's text. The `text` field of a
  chunk is a verbatim slice of canonical text; the only permitted transformation is
  documented, reversible normalization (e.g. expansion of "Dr." for speech) recorded as a
  **separate `spoken_text` field with the original retained**.
- **MUST NOT** invent characters. New identity candidates go to the Character Service.
- **MUST NOT** persist book structure.

### 6.6 Director versioning

`director_version` identifies the whole decision-making bundle: prompt template set,
post-processing logic, validation rules, and the LLM `ModelVersion`. It changes whenever
any of those change. Every `AudioScript` and every `AudioChunk` records it. Mixing
Director versions within a single published audiobook is **forbidden by default**; doing so
requires an explicit, recorded user decision, because it produces audible inconsistency.

---

## 7. Audio Script IR

### 7.1 Role

The **Audio Script Intermediate Representation** is the contract between narrative
intelligence and audio generation. It is the *only* thing a TTS worker receives. If a
worker needs any fact not present in its chunk, the IR is under-specified and that is an
architecture bug.

Test of correctness: *a TTS worker with no database access, no book access, and no network
except object storage must be able to render the chunk correctly from the IR plus the
referenced voice artifact.*

### 7.2 Conceptual structure

An `AudioScriptChunk` conceptually carries:

**Identity & lineage**
- `chunk_id`, `audio_script_id`
- `book_id`, `chapter_id`, `scene_id`, `section_id`
- `sequence_index` (global order within the book), `chapter_sequence_index`
- `source_paragraph_ids[]`
- `source_content_hash` (hash of the exact canonical text rendered)
- `schema_version` (IR schema), `director_version`, `director_model_version`
- `context_bundle_hash`

**Content**
- `text` — verbatim canonical slice
- `spoken_text` — optional normalized-for-speech form (abbreviations, numerals) when it
  differs; `null` means "use `text`"
- `language` (BCP-47), `script` if relevant

**Performance**
- `speaker_type`, `character_id`, `is_dialogue`, `delivery_mode`
- `emotion`, `emotion_intensity`
- `pacing`, `pitch`, `volume`
- `pauses[]` — `{position: LEADING|TRAILING|OFFSET, offset_chars?, duration_ms}`
- `emphasis[]` — `{offset_chars, length_chars, strength}`
- `pronunciation_hints[]` — `{offset_chars, length_chars, ipa | lexicon_key}`

**Voice binding**
- `voice_profile_id`, `voice_profile_version`
- `voice_reference` — resolved object key for embedding/reference audio (resolved at
  generation time, recorded on the audio chunk, not mutated in the IR)

**Generation control**
- `tts_provider_id` (target abstraction, not a hostname)
- `generation_params` — engine-neutral params + provider-specific bag, hashed into
  `generation_params_hash`
- `seed`
- `target_sample_rate`, `target_channels`

**Quality**
- `confidence`, `review_flags[]`, `fallback_applied` (bool + reason)

An `AudioScript` (the parent) carries scope (`book`/`chapter`), Director configuration,
model versions, the full chunk manifest with ordering, and totals used for progress math.

### 7.3 Mutability contract

| Field group | Mutability |
| --- | --- |
| Identity, lineage, `source_content_hash`, `schema_version`, `director_version` | **Immutable from creation.** |
| `text`, `spoken_text`, `language` | **Immutable from creation.** A text change is a new chunk, not an edit. |
| Performance fields, voice binding, generation params, seed | Mutable while chunk state is `DRAFT`/`VALIDATED`. **Frozen the moment a `TTSJob` for this chunk enters `RUNNING`.** |
| `confidence`, `review_flags` | Mutable (annotations, not contract). |

After freeze, any change produces a **new chunk version** with `supersedes = <old chunk_id>`,
and downstream audio for the old version is marked superseded but retained. The chapter
manifest then references the new version. This is how a user "fixes one line" without
invalidating a 14-hour render.

### 7.4 Schema versioning

`schema_version` follows semantic versioning. Additive optional fields → minor. Removal,
renaming, or semantic change of any field → major, and requires a change-control task plus
a documented migration/compatibility statement in
`docs/architecture/audio-script-ir.md`. Workers **MUST** reject a chunk whose major schema
version they do not implement rather than best-effort parse it.

---

## 8. Character system

### 8.1 Principle

**Names are not identities.** "Alice", "Miss Hartwell", "the girl in the blue coat", "she",
and "her sister" may all be one character; "the Captain" may be three different people
across a book. The registry owns identity; text surfaces are merely evidence.

### 8.2 Model

- **`Character`** — the stable identity. Carries canonical display name, importance rank,
  pronoun set(s) with validity ranges, speech traits, first/last appearance, and status
  (`CONFIRMED` / `PROVISIONAL` / `MERGED_INTO` / `RETIRED`).
- **`CharacterAlias`** — a surface form with a type (`GIVEN_NAME`, `FULL_NAME`, `SURNAME`,
  `NICKNAME`, `TITLE`, `EPITHET`, `DESCRIPTOR`, `RELATIONAL`), an optional validity range
  along the spine (aliases can be earned or lost — a character becomes "the Queen" in
  chapter 20), and a scope (global, chapter-scoped, or speaker-scoped: what *Ben* calls
  Alice).
- **Reserved sentinels** (created for every book): `NARRATOR`, `UNKNOWN_SPEAKER`,
  `MULTIPLE_SPEAKERS` (crowd/chorus), `SYSTEM` (headings, footnotes, front matter).
- **Multiple narrators** are ordinary `Character` rows flagged as narrator-capable, with a
  per-chapter/scene narrator binding held in `NarrativeState`. Nothing in the architecture
  assumes exactly one narrator.

### 8.3 Reference resolution contract

Resolution proceeds through ordered strategies; the first that produces a confident answer
wins, and the strategy used is recorded:

1. **Explicit attribution** — an adjacent speech tag ("said Alice"). Highest confidence.
2. **Exact alias match** — surface form matches an alias valid at this spine position.
3. **Scoped alias match** — descriptor/relational alias resolved within the current scene's
   participant set ("the old man" where exactly one scene participant matches).
4. **Pronoun resolution** — constrained by the scene participant set from `NarrativeState`,
   the character's pronoun set, and recency of mention. Never resolved book-globally.
5. **Turn-taking inference** — alternating dialogue in a two-participant scene.
6. **LLM adjudication** — the Director asks, given the L2/L4/L5 context layers, and receives
   a candidate **from the existing registry** plus a confidence.
7. **Fallback** — `UNKNOWN_SPEAKER`, flagged for review.

Non-negotiables:

- The resolver **MUST NOT** invent a new `Character` to make an ambiguity go away. New
  identity candidates are created explicitly, as `PROVISIONAL`, with evidence, and are
  surfaced for confirmation.
- Confidence below the configured threshold **MUST** produce a review flag on the chunk,
  even when a candidate was chosen.
- Resolution results are **cached per book** and invalidated on any alias/merge change.

### 8.4 Merge, split, and re-resolution

When two provisional identities turn out to be one person (common: "the stranger" becomes
"Mordecai" in chapter 9):

1. A merge command records `losing_id → winning_id` and moves aliases.
2. All affected `AudioScriptChunk`s are identified by `character_id`.
3. Chunks not yet generated are re-bound in place (still `DRAFT`).
4. Chunks already generated are **re-versioned** (§7.3) and re-queued, and only the
   affected chunks — never the whole book.
5. Voice assignment conflicts (the two identities had different voices) are surfaced to the
   user as an explicit decision; the system does not pick.

Merges are **auditable and reversible at the record level**: the losing character row is
retained with `MERGED_INTO`.

---

## 9. Voice Registry

### 9.1 The consistency guarantee

> **Character A in chapter 1 and Character A in chapter 20 MUST resolve to the same
> `VoiceProfileVersion`, unless the user explicitly created and approved a new version.**

This is enforced structurally, not by convention:

- Voice binding is resolved from `(book_id, character_id) → active assignment →
  voice_profile_id → locked voice_profile_version`.
- The resolved `voice_profile_version` is **written into the IR chunk** at Director time and
  into the `AudioChunk` lineage at render time.
- A `VoiceProfileVersion` that has produced any retained audio is `LOCKED` and **immutable**.
- Any parameter change creates a **new version**; the previous version continues to serve
  existing audio.
- Assembly **MUST** verify that all chunks in a chapter (and all chapters in a book) that
  share a `character_id` also share a `voice_profile_version`, and fail assembly with a
  specific error if they do not. Consistency is *validated*, not assumed.

### 9.2 Entities

**`VoiceProfile`** — the durable concept ("Narrator", "Alice"). Owns: name, description,
intended character bindings, current active version pointer, lock state, tenant/book scope.

**`VoiceProfileVersion`** — the concrete renderable thing. Carries:

- `voice_profile_id`, `version` (monotonic integer), `supersedes`
- `tts_provider_id`, `tts_model_id`, `tts_model_version`
- `language`, supported languages
- `speaker_reference`: reference-audio object key(s) **and/or** speaker embedding object
  key, with the embedding's extractor model version
- `base_generation_params` (speed, temperature, top-k/p, exaggeration, etc.) + hash
- `default_pitch/volume/pacing` baseline for this voice
- `emotion_capability_map` — which IR emotions this version supports natively vs by
  approximation
- `approval_state`: `DRAFT | PREVIEW_GENERATED | APPROVED | LOCKED | RETIRED`
- `lock_state` + `locked_at` + `locked_reason` (`USED_IN_GENERATION` | `USER_LOCKED`)
- `preview_sample_keys[]`
- `created_by`, provenance of the reference audio (uploaded vs library vs synthesized)

### 9.3 Rules

1. **Never silently mutate.** A write to a `LOCKED` version is a contract error (`409`),
   with a message pointing to version creation. No exceptions, no "small change."
2. **Approval precedes generation.** Full-book generation **MUST** be blocked until every
   `Character` that speaks has an `APPROVED` voice assignment, or the user has explicitly
   accepted the narrator-fallback for unassigned minor speakers.
3. **Model change = new version.** Changing the TTS model or its version cannot preserve
   timbre; it therefore mandates a new `VoiceProfileVersion` and, if audio already exists,
   an explicit user decision about re-rendering.
4. **Reference audio is an artifact, not a parameter.** It lives in object storage,
   content-hashed, and its hash participates in the version identity.
5. **Cross-book reuse:** a tenant-scoped voice *library* MAY exist; a book-scoped
   assignment always pins a specific version, so library edits never reach back into an
   existing audiobook.
6. **Licensing/consent:** reference audio must carry a consent/licensing attestation field.
   Voice cloning of a real person without attested consent is out of scope and MUST be
   refused at the ingestion boundary (§18).

---

## 10. TTS architecture

### 10.1 Position in the system

TTS workers are **stateless renderers on GPU nodes**. They pull IR chunks, render, write to
object storage, record lineage, and report. They contain zero narrative knowledge. They are
the most expensive and the most replaceable part of the system, and the architecture is
built so replacing them is a configuration change, not a redesign.

### 10.2 The `TTSProvider` abstraction

A single internal interface, conceptually:

```
TTSProvider
  id                     -> stable provider identifier (e.g. "xtts-v2", "kokoro-v1")
  capabilities()         -> { models[], languages[], max_input_chars, native_sample_rate,
                              supports_reference_audio, supports_embedding,
                              supports_streaming, emotion_control: none|tags|conditioning,
                              deterministic_seed: bool, max_batch }
  prepare_voice(version) -> ProviderVoiceHandle        # embedding extraction / caching
  synthesize(request)    -> { audio_bytes|object_key, sample_rate, duration_ms,
                              seed_used, provider_metadata }
  health()               -> { status, loaded_models[], vram_free }
```

`SynthesisRequest` is derived **from the IR chunk alone** plus the resolved voice handle.
The adapter is the *only* place where engine-specific translation happens:

- IR `emotion`/`intensity`/`pacing`/`pitch`/`volume` → engine controls (conditioning
  vectors, style tags, speed multipliers, or, where unsupported, documented approximation
  or explicit "unsupported" declaration).
- IR `pauses`/`emphasis`/`pronunciation_hints` → engine markup (SSML-like, phoneme
  substitution) or → **post-processing instructions handed to the Audio Processing stage**
  when the engine cannot express them. Which path is used per provider is documented in
  `tts-provider-specification.md`.

**MUST:** no component outside a provider adapter may reference an engine-specific concept.
No `if (model === 'xtts')` anywhere in the Director, Voice Registry, or orchestration code.

### 10.3 Capability negotiation

Providers declare capabilities; the system reacts rather than assuming:

- A voice profile version is bound to a provider+model; a chunk targeting it is routed only
  to workers advertising that model.
- If an IR field is unsupported by the target provider, the adapter records a
  `capability_gap` on the chunk's generation metadata (e.g. "whisper approximated via
  volume+pacing"). Gaps are visible in QC, never hidden.
- `max_input_chars` from capabilities feeds back into Director chunk sizing (§5.6) via
  configuration, not via runtime coupling.

### 10.4 GPU worker lifecycle

1. **Boot:** read assigned model set from config → download/verify weights from a model
   cache (object storage or a mounted volume) → verify checksum against `ModelVersion` →
   load into VRAM → warm up with a throwaway synthesis → register capabilities → begin
   consuming.
2. **Steady state:** long-lived process, model resident. Model load is amortized across
   thousands of chunks and **MUST NOT** happen per job.
3. **Voice handling:** speaker embeddings extracted once per `VoiceProfileVersion`, cached
   in VRAM/host memory with an LRU, and persisted to object storage so other workers reuse
   them. Reference audio is never re-processed per chunk.
4. **Concurrency:** one model instance per GPU by default; intra-process concurrency limited
   by VRAM headroom and measured throughput. Workers advertise their own concurrency; the
   queue does not guess.
5. **Batching:** where the engine supports it, chunks sharing `(model, voice_version,
   generation params)` are batched. Batches **MUST NOT** cross voice versions unless the
   engine provably supports per-item conditioning. Batching is an optimization behind the
   provider interface and never changes per-chunk lineage or output identity.
6. **Heartbeats:** periodic liveness + progress to the Job Service; a missed deadline makes
   the attempt reapable (§16.5).
7. **Draining:** on SIGTERM, stop accepting work, finish in-flight chunks within a grace
   period, then exit. In-flight work that cannot finish is released back to the queue
   (visibility restored), not lost.
8. **Retries/timeouts:** per-chunk timeout scaled by input length; retries with backoff;
   OOM handled by batch reduction then single-item then failure. Retries are attempts on the
   same job (§16), each recorded.
9. **Model versioning:** every worker reports the exact model version it loaded; the
   rendered chunk records it. A worker running an unexpected model version is quarantined
   rather than allowed to produce mixed-version audio.

### 10.5 Model and hardware neutrality

The architecture assumes only: a GPU worker pool, a queue, object storage, and the
`TTSProvider` interface. Adding nodes, changing GPU models, or switching engines requires
**no change** to the IR, the Director, the Voice Registry, the queue contracts, or the API
(§20.4).

---

## 11. Queue and event architecture

### 11.1 Technology decision: Redis + BullMQ

**Selected:** Redis + BullMQ for jobs; Redis Streams / BullMQ events for domain events.

Reasoning: the workload is **job-shaped, not log-shaped**. It needs per-job state, delayed
retries, priorities, cancellation, per-book concurrency limits, and progress — all of which
BullMQ provides natively and Kafka does not. Expected event volume (thousands per book, not
millions per second) is far below the threshold where Kafka's durability/replay model pays
for its operational cost. Redis is already required for caching, locks, and progress.

Kafka is reconsidered only if one of these becomes true (documented trigger conditions):
multi-consumer replay of the full event history becomes a product requirement; event
throughput exceeds Redis capacity; or cross-organization event distribution is needed. Such
a move is a change-control task, and §11.3's event contracts are designed to survive it —
event payloads carry no Redis-specific semantics.

**Python workers** consume from the same Redis via a BullMQ-compatible client, or via a thin
queue-adapter module maintained alongside the TS implementation. The queue *contract*
(key naming, payload schema, ack semantics) is language-neutral and documented in
`event-contracts.md`.

### 11.2 Commands (jobs) — imperative, addressed, retried

A **command** tells one consumer to do one thing. Exactly one logical consumer. Retryable.
Idempotent. Named `verb_noun`.

| Job type | Queue | Runtime | Notes |
| --- | --- | --- | --- |
| `parse_book` | `parse` | CPU | fan-out to `ocr_page` for scanned input |
| `ocr_page` | `parse` | CPU | per-page isolation |
| `normalize_text` | `parse` | CPU | |
| `analyze_structure` | `parse` | CPU | |
| `analyze_scene` | `ai` | LLM | sequential per book |
| `build_story_bible_delta` | `ai` | LLM | sequential per book |
| `generate_director_ir` | `ai` | LLM | parallel within an analyzed scene |
| `revise_director_ir` | `ai` | LLM | targeted re-run after edits/merges |
| `generate_voice_preview` | `gpu` | GPU | high priority, short |
| `generate_tts_chunk` | `gpu` | GPU | the bulk of all work |
| `validate_audio` | `audio` | CPU | |
| `process_audio` | `audio` | CPU | loudness, silence, resample |
| `verify_transcript` | `gpu`/`audio` | ASR | sampled in v1 (§14.4) |
| `assemble_chapter` | `audio` | CPU | |
| `assemble_audiobook` | `audio` | CPU | |
| `encode_delivery_format` | `audio` | CPU | |
| `cleanup_artifacts` | `maintenance` | CPU | retention policy |

### 11.3 Events — declarative, broadcast, not retried into the domain

An **event** states that something happened. Zero or more consumers. Never used to *command*
work in a way that couples producers to consumers' internals.

`book.uploaded`, `book.parse_started`, `book.parsed`, `book.parse_failed`,
`book.structure_ready`, `book.analysis_completed`,
`character.discovered`, `character.merged`, `character.confirmed`,
`voice.preview_requested`, `voice.preview_ready`, `voice.approved`, `voice.locked`,
`voice.version_created`,
`director.started`, `director.chunk_completed`, `director.completed`, `director.failed`,
`tts.started`, `tts.chunk_completed`, `tts.chunk_failed`, `tts.completed`,
`audio.validated`, `audio.validation_failed`,
`chapter.assembly_started`, `chapter.completed`,
`audiobook.assembly_started`, `audiobook.completed`, `audiobook.failed`,
`job.created`, `job.started`, `job.progress`, `job.retrying`, `job.failed`,
`job.cancelled`, `job.dead_lettered`.

Every event envelope carries: `event_id`, `event_type`, `schema_version`, `occurred_at`,
`tenant_id`, `book_id?`, `correlation_id` (trace), `causation_id` (the command/event that
caused it), `producer` + `producer_version`, and a typed `payload`. Full schemas belong in
`docs/architecture/event-contracts.md`.

**Rule:** events carry **identifiers and small facts, not large payloads**. Text and audio
travel by object key, never inline.

### 11.4 Required queue semantics

| Capability | Contract |
| --- | --- |
| **Retries** | Per-job-type max attempts; distinguish *retryable* (timeout, 5xx, OOM, transient storage) from *terminal* (schema violation, missing voice, unauthorized, malformed input). Terminal errors **MUST NOT** be retried. |
| **Backoff** | Exponential with full jitter; per-job-type base and ceiling. LLM/TTS providers get longer ceilings. |
| **Idempotency** | Every job carries an `idempotency_key` derived from its semantic identity (e.g. `tts:{chunk_id}:{lineage_hash}`). Re-delivery of the same key while a result exists returns the existing result and performs no work. |
| **Dead letter** | After max attempts a job moves to a DLQ with full error context and stays there for inspection; DLQ jobs are replayable by an operator after the cause is fixed. Nothing is silently dropped. |
| **Priority** | `INTERACTIVE` (voice previews, single-chunk regeneration) > `NORMAL` (full-book generation) > `BULK` (backfills, re-encodes, cleanup). Interactive work must never starve behind a 20-hour render. |
| **Progress** | Workers report progress (`0..1` + stage label) at a bounded rate; aggregated per book by the Job Service. Progress is derived from *completed units*, never estimated from wall clock. |
| **Cancellation** | Cooperative: a cancel sets job state and a Redis cancellation flag; workers check it at chunk boundaries and between expensive steps, then exit cleanly, releasing partial artifacts as `CANCELLED`. Queued jobs are removed. Already-completed work is retained (a cancelled book keeps its finished chunks and can resume). |
| **Resumability** | Because every unit of work is addressed by stable identity + lineage and its output is persisted, restarting a book skips all units whose output already exists and is valid. |
| **Fairness** | Per-tenant and per-book concurrency caps prevent one large book from monopolizing the GPU pool. |

### 11.5 Locks and ordering

Redis locks with fencing tokens guard: per-book narrative-analysis sequencing, Story Bible
snapshot writes, chapter assembly, audiobook assembly, and voice version transitions. Lock
holders renew via heartbeat; expiry releases the lock, and the fencing token prevents a
resurrected stale holder from writing.

---

## 12. Storage architecture

### 12.1 PostgreSQL — transactional metadata

Holds: all entities in §4.2 *except* binary artifacts; job/attempt state; lineage; Story
Bible structured facts; vector embeddings (pgvector) in v1; audit records.

Rules: object storage keys are stored as strings; **no** audio, no images, and no full
parsed documents are stored as bytes in PostgreSQL. Large text (chapter-level canonical
text) lives in object storage with a hash + preview in the DB.

### 12.2 Redis — ephemeral state

Holds: BullMQ queues and job runtime state; distributed locks; rate-limit counters; hot
Story Bible working sets; character-resolution and voice-resolution caches; progress
counters; SSE pub/sub; short-TTL token verification cache; upload sessions.

**Rule: Redis is never the sole source of truth for anything durable.** Every Redis key must
be rebuildable from PostgreSQL or object storage. Losing Redis costs time, never data
(§21.13).

### 12.3 S3-compatible object storage (MinIO in dev, S3-compatible in prod)

Holds: original uploads, parsed artifacts, OCR outputs, canonical text, reference audio,
speaker embeddings, generated audio chunks, processed chunks, chapter audio, final
audiobooks, cover images, preview samples, model weight cache, exported reports.

Key convention (a **contract**, not a suggestion) — hierarchical, tenant-scoped,
version-bearing, immutable:

```
{tenant_id}/books/{book_id}/source/{book_file_id}.{ext}
{tenant_id}/books/{book_id}/parsed/{parse_version}/document.json
{tenant_id}/books/{book_id}/canonical/{content_hash}/chapter-{n}.txt
{tenant_id}/voices/{voice_profile_id}/v{version}/reference-{hash}.wav
{tenant_id}/voices/{voice_profile_id}/v{version}/embedding-{extractor_version}.bin
{tenant_id}/books/{book_id}/audio/chunks/{chunk_id}/v{gen_version}.wav
{tenant_id}/books/{book_id}/audio/chapters/{chapter_id}/v{version}.wav
{tenant_id}/books/{book_id}/audiobooks/{audiobook_id}/v{version}.m4b
{tenant_id}/books/{book_id}/previews/{voice_profile_version_id}/{sample_id}.wav
```

Additional rules:
- Buckets are **private**. All access is via short-lived signed URLs (§18.7) or via the
  service's own credentials. No public bucket, ever.
- Versioning enabled at the bucket level as defence-in-depth; application-level versioning
  in the key is still mandatory (bucket versioning is not a contract, it is a safety net).
- Lifecycle rules: intermediate WAV chunks are the largest cost driver and are transitioned
  to cheap storage or expired after the audiobook is completed and validated, per a
  documented retention policy. **Chunks are not deleted while their audiobook is
  regenerable-on-demand and the user retains edit rights** — the retention window is a
  product decision recorded in `deployment-architecture.md`.
- Multipart upload for anything above the configured threshold; checksums verified on
  completion.

---

## 13. Audio pipeline

### 13.1 Flow

```
TTS output (raw chunk)
 → technical validation        (reject/flag before spending more compute)
 → loudness normalization      (per-chunk pre-normalization to a working target)
 → silence & pause processing  (trim engine artifacts; apply the IR pause plan)
 → optional crossfade          (only at joins, short, configurable)
 → chapter assembly            (ordered concat + chapter-level loudness pass)
 → audiobook assembly          (chapter concat, markers, metadata, cover)
 → final encoding              (delivery containers/bitrates)
```

### 13.2 Format policy

| Stage | Format | Rationale |
| --- | --- | --- |
| Chunk (intermediate) | WAV, PCM, engine-native sample rate → resampled to a single project sample rate | Lossless; repeated re-encoding of chunks would compound artifacts |
| Chapter (intermediate) | WAV or FLAC | Lossless; large but transient |
| Delivery — audiobook | **M4B** (AAC in MP4, chapter markers, cover, metadata) | The audiobook-native container; chapter navigation works in every player |
| Delivery — alternate | MP3 per chapter, and/or a single M4A | Universal compatibility; podcast-style consumption |
| Streaming | HLS/segmented AAC (deferred to §14 of the delivery phase) | Range-request MP4 is sufficient for v1 |

**Rule:** exactly **one** lossy encode, at the final delivery step. Intermediates are never
lossy, and lossy output is never re-used as an input to further processing.

### 13.3 Loudness and pause craft

- Target loudness follows audiobook distribution norms (nominal −18 to −20 LUFS integrated
  with a true-peak ceiling around −3 dBTP; exact targets are configuration recorded in
  `deployment-architecture.md`, not hardcoded).
- Normalization is applied **in two passes**: a light per-chunk pass so joins do not jump,
  and an authoritative per-chapter/whole-book integrated pass so the finished product is
  consistent end to end.
- Pause durations come from the IR pause plan (§7.2), not from whatever silence the engine
  happened to emit. Engine-emitted leading/trailing silence is trimmed first, then the
  intended pause is inserted. This is what makes pacing reproducible across engines.
- Crossfade is used only to hide join clicks (single-digit milliseconds) and is disabled by
  default for dialogue transitions where a clean cut is more natural.

### 13.4 Metadata

Final artifacts carry: title, author, narrator credit ("AI-narrated" disclosure), series,
publisher, language, publication year, description, cover art, chapter markers with titles
and exact offsets, total duration, and a generation provenance block (pipeline version,
Director version, TTS model versions). AI narration disclosure is **mandatory** in output
metadata.

---

## 14. Quality control

QC runs at four levels; each has its own failure semantics and none is optional.

### 14.1 Text validation (post-parse, pre-analysis)

Checks: expected-vs-extracted character count per page/section; missing pages; duplicated
blocks (headers/footers leaking into body); OCR confidence below threshold; broken reading
order; chapter count sanity (zero chapters, or one chapter for a 400-page book);
encoding/mojibake detection; unbalanced quotation marks (a strong signal of dialogue
mis-parsing); empty or near-empty chapters; suspicious repetition.

Outcome: `PASS`, `WARN` (proceed, flag), or `NEEDS_REVIEW` (block, surface a diff view to
the user). Text errors are the cheapest to fix and the most expensive to ignore — they
propagate through every later stage.

### 14.2 Director validation (post-IR, pre-TTS)

Schema validation first (hard fail), then semantic checks: unknown or `UNKNOWN_SPEAKER`
speaker above a tolerated rate; missing or unapproved voice profile; emotion/delivery value
outside the closed vocabulary; pacing/pitch/volume out of allowed range; pause offsets
outside the text; emphasis spans out of bounds; overlapping spans; `text` hash mismatch
against the source paragraph; chunk exceeding the target provider's `max_input_chars`;
dialogue attributed to a character not present in the scene; coverage gaps (canonical text
not covered by any chunk) and overlaps (text covered twice).

**Coverage is a hard invariant:** the concatenation of chunk `text` for a chapter MUST
reconstruct the chapter's canonical text exactly (modulo declared `spoken_text`
substitutions). This single check catches most silent content loss.

### 14.3 TTS/technical validation (post-generation)

Checks: file exists and is decodable; duration > 0; duration within an expected band derived
from character count and pacing (catches truncation and runaway repetition — a known
failure mode of autoregressive TTS); true-peak clipping; DC offset; sample rate and channel
count match the project target; leading/trailing silence beyond threshold; internal silence
gaps beyond threshold; RMS below a floor (near-silent output); NaN/Inf samples; abrupt
level discontinuities.

Failure marks the **chunk** `INVALID` with a reason code and triggers regeneration of that
chunk only, with a bounded attempt count before escalating to `NEEDS_REVIEW`.

### 14.4 Content validation (ASR round-trip)

Architecture (v1: **sampled**; v2: configurable coverage):

```
AudioChunk → ASR → transcript → normalize both sides → align → WER / CER
```

- Normalization before comparison must be documented and symmetric (case, punctuation,
  numbers, contractions), otherwise WER is noise.
- Thresholds are per-chunk and per-chapter; exceeding them flags for regeneration or review.
- v1 samples a configurable percentage of chunks plus **100% of high-risk chunks** (long
  chunks, low Director confidence, chunks containing lexicon terms, chunks that already
  failed once). Full-coverage ASR is a cost decision, not an architectural one — the
  architecture supports both.
- ASR runs as its own job type on GPU or CPU workers and **never blocks** assembly by
  default; it can be configured as a gate for a "verified" build.
- Reported metrics: per-chunk WER, per-chapter WER, and a book-level quality score stored
  on the `Audiobook` for auditability.

### 14.5 Human review surface

Everything above produces **review items** attached to a book, typed and prioritized, with
a direct link to the offending chunk, its text, its audio, and a one-click regenerate/edit
action. QC that no human can act on is telemetry, not quality control.

---

## 15. Voice preview workflow

### 15.1 Why it is mandatory

Full-book generation costs GPU-hours and real money. Discovering after 14 hours that the
protagonist sounds wrong is unacceptable. **Casting is a gate, not a suggestion.**

### 15.2 Flow

```
1. Character detection            → provisional cast list, ranked by line count/importance
2. Cast review (user)             → confirm/merge/rename characters, mark non-speaking
3. Proposed voice assignment      → system proposes profiles from the library using
                                    Story Bible traits (age/gender presentation as stated
                                    in the text, register, dialect notes)
4. Preview sample generation      → per character, N short samples drawn from *that
                                    character's actual lines*, spanning emotions present
                                    in the book (INTERACTIVE priority)
5. User review                    → approve / adjust params / pick another voice /
                                    upload reference audio → regenerate preview
6. Approval                       → VoiceProfileVersion.approval_state = APPROVED
7. Lock                           → assignment frozen; version becomes LOCKED on first
                                    production render
8. Full generation                → unblocked
```

### 15.3 Gate rules

- Generation of a chapter is blocked unless **every speaking character in that chapter** has
  an approved assignment, or the user has explicitly accepted narrator-fallback for
  unassigned minor speakers (recorded as an explicit decision on the book).
- Preview samples are generated with the **same provider, model version, and generation
  parameters** as production. A preview that does not predict production output is worse
  than no preview.
- Previews are cheap and disposable; they are stored separately from production audio and
  are not part of any audiobook lineage.

### 15.4 Changing a voice after generation

Mutation is forbidden. The flow is:

1. User requests a voice change for character X.
2. System creates `VoiceProfileVersion v(n+1)` (DRAFT) — the old version stays intact.
3. Preview → approve.
4. System computes the **impact set**: all chunks bound to `(X, v(n))`, grouped by chapter,
   with an estimated cost and duration.
5. User confirms scope: whole book, or specific chapters (with an explicit warning that a
   partial re-voice produces an inconsistent audiobook — the system recommends whole-book
   and requires acknowledgement otherwise).
6. Affected `AudioScriptChunk`s are re-versioned with the new voice binding; new `TTSJob`s
   are enqueued; old `AudioChunk`s are marked `SUPERSEDED` but retained.
7. Affected chapters are re-assembled; the audiobook gets a new version.

At no point is an existing artifact overwritten, and at every point the previous audiobook
version remains playable.

---

## 16. Job state machine

### 16.1 States

```
CREATED ──► QUEUED ──► RUNNING ──► SUCCEEDED        (terminal, success)
              ▲           │
              │           ├──► RETRYING ──► QUEUED   (attempt < max, retryable error)
              │           │
              │           ├──► FAILED               (terminal, failure)
              │           ├──► CANCELLED            (terminal, user/system cancel)
              │           └──► BLOCKED ──► QUEUED    (waiting on dependency or human review)
              │
        (dependency satisfied / review resolved)

FAILED ──► DEAD_LETTERED   (after max attempts; operator-replayable → CREATED)
```

- `CREATED` — persisted intent, dependencies not yet satisfied or not yet enqueued.
- `BLOCKED` — explicit wait: an upstream job, or a human gate (cast approval, review item).
- `RETRYING` — a scheduled, backed-off return to `QUEUED`. Distinct from `QUEUED` so
  dashboards and alerts can see retry pressure.
- `DEAD_LETTERED` — exhausted; requires operator or user action. Never auto-purged.

Terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`, `DEAD_LETTERED`. Transitions are
recorded with timestamp, actor, and reason. **The Job Service is the sole authority on job
state**; the queue is a delivery mechanism whose state is reconciled against the database.

### 16.2 Attempts

Each transition into `RUNNING` creates a `ProcessingAttempt` recording: attempt number,
worker id, host, model versions loaded, start/end time, outcome, error class + message,
resource usage (VRAM peak, duration), and output artifact reference. Attempts are immutable
and are the audit trail for "why does this chunk sound different?"

### 16.3 Idempotency

Every job has an `idempotency_key` computed from its semantic identity and lineage:

```
parse:{book_file_id}:{parser_version}
director:{chunk_scope_id}:{content_hash}:{director_version}:{context_bundle_hash}
tts:{audio_script_chunk_id}:{voice_profile_version}:{tts_model_version}:{params_hash}
assemble_chapter:{chapter_id}:{ordered_chunk_manifest_hash}
```

Contract: enqueueing an existing key that is `RUNNING` or `SUCCEEDED` returns the existing
job handle and performs no work. Workers re-check before doing expensive work (defence
against at-least-once delivery). Idempotency keys are persisted with a retention window
long enough to cover the longest possible retry horizon.

### 16.4 Granularity — the regeneration guarantee

> **A failed chunk MUST be regenerable without regenerating its chapter, and a failed
> chapter without regenerating the book.**

This is guaranteed structurally: `generate_tts_chunk` is scoped to one `AudioScriptChunk`;
`assemble_chapter` is a pure function of an ordered chunk manifest; `assemble_audiobook` is
a pure function of an ordered chapter manifest. Re-running any of them touches nothing
below it. Book-level "jobs" are **DAG coordinators** that track child jobs; they never do
work themselves and never need to re-run children that already succeeded.

### 16.5 Recovery

- **Orphan reaping:** a `RUNNING` job whose worker has missed its heartbeat deadline is
  moved to `RETRYING` (if retryable and attempts remain) or `FAILED`. Fencing tokens ensure
  a resurrected worker cannot write a result for a reaped attempt.
- **Restart:** on service start, the Job Service reconciles PostgreSQL against the queue,
  re-enqueuing `QUEUED`/`RETRYING` jobs missing from Redis and reaping stale `RUNNING` ones.
- **Resume:** resuming a book re-evaluates the DAG and enqueues only units with no valid,
  current output for the current lineage.
- **Partial output:** artifacts from a cancelled or failed run are retained and valid if
  they passed validation; they participate in the next run's skip logic.

---

## 17. Observability

### 17.1 Structured logging

JSON logs, one event per line, with a mandatory core: `timestamp`, `level`, `service`,
`service_version`, `env`, `trace_id`, `span_id`, `correlation_id`, `tenant_id`, `user_id?`,
`book_id?`, `job_id?`, `chunk_id?`, `event`, `message`, plus typed fields. No PII beyond
identifiers; **book text is never logged at info level** (copyright + volume). Errors carry
an error class from a documented taxonomy, not just a string.

### 17.2 Metrics (Prometheus)

| Domain | Metrics |
| --- | --- |
| API | request rate, latency histogram (p50/p95/p99), error rate by class, rate-limit rejections |
| Queue | depth per queue, oldest-message age, enqueue/dequeue rate, wait-time histogram, DLQ size |
| Jobs | throughput by type, duration histogram by type, failure rate by type and error class, retry rate, attempts-per-success, cancellation rate |
| LLM | tokens in/out, latency, cost, schema-validation failure rate, fallback rate, degraded-bundle rate |
| TTS | chunks/minute per worker, real-time factor (audio seconds ÷ compute seconds), latency histogram, OOM count, batch size distribution, model-load count (should be near zero in steady state) |
| GPU | utilization, VRAM used/free, temperature, power, per-node worker count |
| Audio | validation pass/fail by check, WER distribution, regeneration rate, loudness deviation |
| Pipeline | book stage durations, end-to-end book latency, % books requiring review, chunks-per-book |
| Storage | bytes by class and tenant, object count, egress |
| Cost | **cost per audiobook** (GPU seconds × rate + LLM tokens × rate + storage + egress), cost per audio hour, cost per chunk, tracked per book and per tenant |

Cost per audiobook is a **first-class product metric**, computed from recorded attempt
resource usage, not estimated.

### 17.3 Tracing (OpenTelemetry)

One trace per user-initiated operation, propagated across HTTP **and** through queue
messages via the `correlation_id`/`traceparent` fields in the job envelope. A production
run of a book yields a trace tree: book → chapters → chunks → attempts. Sampling is
head-based for high-volume chunk work with 100% retention of errored traces.

### 17.4 Logs, dashboards, alerting

Loki for log aggregation; Grafana for dashboards (per-book pipeline view, worker fleet view,
cost view, QC view); Prometheus Alertmanager for alerts. Minimum alert set: DLQ non-empty,
queue oldest-age above SLO, GPU worker fleet below expected size, TTS failure rate spike,
LLM schema-failure spike, storage growth anomaly, book stuck in a state beyond threshold.

### 17.5 Correlation guarantee

Given a `book_id`, an operator **MUST** be able to retrieve: every job and attempt, every
log line, every trace, every artifact key, every model version, and the total cost. This is
an architectural requirement on identifier propagation, not a dashboard feature.

---

## 18. Security

**Uploaded books are untrusted input. LLM output is untrusted input. Both are treated as
hostile until validated.**

### 18.1 Authentication

Short-lived access tokens + rotating refresh tokens; secure, `HttpOnly`, `SameSite` cookies
for browser sessions; MFA-capable; service-to-service auth via mTLS or signed service
tokens with narrow audiences. Token verification fails closed. No long-lived static API
keys for user auth; if programmatic API keys are added, they are scoped, hashed at rest,
revocable, and rotated.

### 18.2 Authorization

- **Every** resource access is checked against the `tenant_id` of the authenticated
  principal. Ownership check happens in the owning service, not only at the gateway.
- Object-level authorization for books, jobs, voices, audio. Role-based access for
  workspace/project collaboration; permission checks are deny-by-default.
- **Job authorization:** a user may only create, read, cancel, or replay jobs whose target
  resources they own. Worker-issued job state transitions use service credentials and are
  validated against the job's recorded tenant.
- Signed URLs are minted only after an ownership check and encode the exact object.

### 18.3 Upload validation

Enforced in order, all mandatory: authenticated upload session → per-tenant quota check →
declared size within limit → hard byte-count enforcement during transfer (not just the
declared header) → magic-byte sniffing → declared MIME must agree with sniffed type →
extension allowlist → per-format structural sanity check → malware scan → decompression
bomb guards (page count, image dimensions, EPUB zip expansion ratio and entry count) →
only then is the file admitted.

### 18.4 Malicious document handling

- Parsers run in a **sandboxed, resource-capped context** (separate process, memory/CPU/time
  limits, no outbound network, minimal filesystem).
- PDF JavaScript, embedded launch actions, and external references are stripped/ignored.
- EPUB: entry names sanitized; **path traversal (`../`, absolute paths, symlinks) rejected**;
  remote resources not fetched; XML parsed with external entity resolution disabled (XXE).
- SVG/HTML content inside EPUB is sanitized before any rendering in the UI.
- Image OCR paths guard against decompression bombs and malformed headers.
- A crashing or hanging parse fails the job; it never takes down a worker's host.

### 18.5 Path traversal and key construction

Object keys are **constructed by the server from validated identifiers only**. No
user-supplied string ever becomes part of a key path. Filenames from uploads are stored as
metadata, never used as keys. Every key is validated against its expected pattern before
use.

### 18.6 Rate limiting and abuse

Per-IP, per-user, and per-tenant limits at the gateway; separate, stricter limits on
expensive operations (upload, preview generation, full-book generation). Quotas on
concurrent books, GPU-minutes, and storage per tenant. Backpressure returns `429` with
`Retry-After`, never a silent drop.

### 18.7 Object storage access

Private buckets. Short-lived (minutes) signed URLs, scoped to a single object and method.
Download URLs bound to the requesting principal where the storage backend supports it.
Streaming uses signed URLs with range support and short expiry, refreshed by the client.
Server-side encryption at rest; TLS in transit.

### 18.8 Secrets

No secrets in code, images, or the repository. Environment injection in development; a
secrets manager in staging/production. Rotation supported for DB, Redis, object storage,
and model-provider credentials. Distinct credentials per service with least privilege
(e.g. TTS workers get write access only to the audio prefix).

### 18.9 Prompt injection

Book text is adversarial by assumption — a book can contain "ignore previous instructions."
Mitigations, all required:

1. **Structural separation:** instructions live in the system prompt; book text is passed in
   clearly delimited, labelled user-content regions.
2. **Least authority:** the Director's LLM has **no tools, no network, no database writes**.
   It returns data; the service decides what to persist. Compromising the model's output
   cannot compromise the system, only that chunk's quality.
3. **Output-shape enforcement:** responses are validated against a strict schema with closed
   vocabularies (§6.3). Anything else is a validation failure.
4. **Referential validation:** every `character_id`, `voice_profile_id`, and offset in LLM
   output must resolve to an existing, authorized entity **owned by the same book**. IDs that
   do not exist are rejected — the model cannot conjure a reference to another tenant's data.
5. **Text fidelity check:** `text` fields are verified by hash against the source; the model
   cannot inject content into what gets spoken.
6. **No instruction echo:** model output is never executed, never used to build queries,
   never used to construct storage keys, and never rendered as HTML without escaping.

### 18.10 LLM output validation summary

Schema → enumeration → referential integrity → range/bounds (offsets, intensities) →
coverage/overlap → text-hash fidelity → confidence thresholds. Only then does IR become
`VALIDATED`. Failure path: repair pass → bounded retry → deterministic fallback with a
review flag.

### 18.11 Content and legal boundary

Uploaded books may be copyrighted; the platform stores them per-tenant, never shares them
across tenants, never uses them as training data, and honors deletion. Reference audio
requires a consent attestation (§9.3.6). Output metadata discloses AI narration (§13.4).

---

## 19. Multi-tenancy

### 19.1 Ownership model

```
Tenant (account/organization)
  └── Project / Workspace (optional grouping, v1 may default to a single implicit project)
        └── Book
              ├── BookFile, Chapter/Section/Scene/Paragraph
              ├── Character / CharacterAlias
              ├── StoryBible / NarrativeState
              ├── AudioScript / AudioScriptChunk
              ├── AudioChunk / ChapterAudio / Audiobook
              └── ProcessingJob / ProcessingAttempt
Tenant
  └── VoiceProfile / VoiceProfileVersion   (tenant-scoped library, book-scoped assignments)
```

- **`tenant_id` is mandatory on every user-owned row** and is part of every query predicate.
  Not "usually" — every query.
- A **shared system voice library** may exist as a distinct, read-only, system-owned scope.
  Using a system voice creates a **tenant-scoped version snapshot** so that a system library
  update can never alter an existing audiobook.
- Jobs carry `tenant_id`; workers propagate it into logs, metrics, artifacts, and keys.
- Object keys are tenant-prefixed (§12.3), enabling both isolation and per-tenant
  policy/cost accounting.

### 19.2 Isolation guarantees

- No cross-tenant read is possible through any API path; ownership is checked in the owning
  service, and repository-level access is scoped by tenant by construction (not by a
  developer remembering a `WHERE` clause — enforced by a shared data-access layer).
- No cross-tenant artifact reuse. Two tenants uploading the identical book get separate
  storage, separate parses, separate everything. Content-hash dedupe **within** a tenant is
  permitted; across tenants it is forbidden (it would leak existence of content).
- Per-tenant quotas and rate limits prevent noisy-neighbour resource capture.
- Deletion is tenant-scoped and complete: metadata, artifacts, caches, and queue entries.

Future stricter isolation (dedicated buckets, schema-per-tenant, dedicated GPU pools) is
possible without contract change because tenancy is already an explicit dimension
everywhere.

---

## 20. Scalability

### 20.1 Scaling units

| Unit | Bottleneck | Scaling trigger | Notes |
| --- | --- | --- | --- |
| `web` / `api` | Request concurrency | CPU / p95 latency | Stateless; trivially horizontal |
| Parse/OCR workers | CPU, page count | `parse` queue depth/age | OCR dominates; page-level parallelism |
| Director / AI workers | LLM throughput & context tokens | `ai` queue depth, LLM latency | Capped per book by ordering (§5.5); scale across books |
| Audio CPU workers | FFmpeg CPU, object-storage I/O | `audio` queue depth | Cheap, highly parallel |
| **GPU TTS workers** | VRAM, GPU compute | `gpu` queue depth/age, RTF | The dominant cost and the dominant latency |
| PostgreSQL | Write throughput on chunk-level rows | connection saturation, replication lag | Read replicas for read models; partition chunk tables by book |
| Redis | Memory, ops/sec | memory pressure | Separate instance for queues vs cache once contended |
| Object storage | Effectively unbounded | — | Cost, not capacity, is the constraint |

### 20.2 Why GPU workers must scale independently

1. **Cost asymmetry:** a GPU node costs one to two orders of magnitude more per hour than an
   API node. Coupling them wastes money continuously.
2. **Demand asymmetry:** TTS demand is bursty and enormous (a 12-hour audiobook is tens of
   thousands of chunk renders) while API demand is small and steady.
3. **Failure asymmetry:** GPU workers OOM, hang on driver faults, and need draining
   restarts. That must never affect the API.
4. **Placement asymmetry:** GPUs live where GPUs are available — a different node pool,
   possibly a different provider, possibly on-premises.
5. **Elasticity:** the ideal steady state is *zero* idle GPU workers; the pool scales from
   zero on queue depth and back to zero when drained.

### 20.3 Throughput model

Total render time ≈ `total_audio_seconds / (RTF_effective × parallel_workers)`. The only
levers are RTF (model/engine/batching) and worker count. The architecture therefore makes
chunk-level parallelism the default and keeps chunks independent — no chunk may depend on
another chunk's audio output.

### 20.4 Adding GPU capacity

Adding a node requires: the node joins the pool, pulls its model set, verifies checksums
against `ModelVersion`, registers capabilities, begins consuming from the `gpu` queue.
**No application change, no contract change, no redeploy of other services.** This is a
hard architectural requirement and a design test: if adding a GPU node ever requires
touching the Director or the IR, the abstraction has been violated.

### 20.5 Backpressure

When GPU queue age exceeds its SLO, the system: (a) raises priority of interactive work,
(b) admits new full-book generations more slowly (admission control at job creation, with
a user-visible queued position), and (c) emits scale-up signals. It never drops jobs and
never blocks HTTP requests.

---

## 21. Failure and recovery

Legend — **Resumable**: can the operation continue from where it stopped rather than
restarting?

| # | Failure | Retry | Recovery | User-visible state | Resumable |
| --- | --- | --- | --- | --- | --- |
| 1 | **Upload failure** (network, aborted) | Client retries; multipart resumes parts | Incomplete uploads expire and are GC'd; hash mismatch → reject and re-request | `UPLOAD_FAILED` with reason; retry offered | Yes (multipart part-level) |
| 2 | **Parser failure** (corrupt/unsupported PDF) | 2 attempts; then alternate strategy (digital→OCR fallback) | Try secondary extractor; if all fail, `NEEDS_REVIEW` with diagnostics and a manual-format hint | `PARSE_FAILED` / `NEEDS_REVIEW` | Yes (per page/section) |
| 3 | **OCR failure** (page-level) | 3 attempts with preprocessing variations | Failed pages isolated and marked; book proceeds with gaps flagged; user may re-upload better scans for those pages | `PARTIAL_OCR` + page list | Yes (per page) |
| 4 | **LLM timeout** | Exponential backoff, 3 attempts; then reduced-context retry | Reduce bundle to L1+L4+L5+L6; if still failing, split the chunk; then fallback IR | Book stays `SCRIPTING`; chunk flagged | Yes (per chunk) |
| 5 | **Malformed LLM output** | Schema-repair pass, then 2 retries with stricter instruction | Deterministic fallback IR (narrator, neutral, default pacing) + `review_flag=DIRECTOR_FALLBACK` | Chunk flagged for review; book proceeds | Yes (per chunk) |
| 6 | **Missing/unresolvable character** | No retry (not transient) | Bind to `UNKNOWN_SPEAKER`, apply narrator voice, raise a review item | Review item on the book | Yes |
| 7 | **Missing voice profile** | No retry | **Block generation** for affected chunks; surface a casting task | `BLOCKED_ON_CASTING` | Yes (unblocks on approval) |
| 8 | **GPU OOM** | Reduce batch → single item → 2 attempts | Route to a node with more VRAM or a smaller model variant if configured; else fail the chunk | Chunk `FAILED`; chapter continues | Yes (per chunk) |
| 9 | **TTS failure** (engine error) | 3 attempts, backoff, different worker | New seed on final attempt; then `NEEDS_REVIEW` for that chunk | Chunk flagged; progress shows N failed | Yes (per chunk) |
| 10 | **Audio corruption / validation failure** | Regenerate chunk, 2 attempts | Persistent failure → `NEEDS_REVIEW` with the failing check named and audio available for listening | Chunk `INVALID` | Yes (per chunk) |
| 11 | **Worker crash mid-job** | Heartbeat expiry → reap → requeue | Fencing token invalidates any late write from the dead worker; partial artifacts discarded (they were never marked valid) | No user-visible change if retry succeeds | Yes |
| 12 | **Duplicate job delivery** | N/A | Idempotency key check before work and before write; existing result returned | Invisible | N/A |
| 13 | **Redis failure** | Workers back off and retry connection | Job state is rebuilt from PostgreSQL on recovery; queues re-populated from `QUEUED`/`RETRYING` rows; caches rebuild lazily; **no data loss, only delay**. In-flight jobs are reaped by heartbeat and retried. | `DEGRADED` banner; new heavy work admission paused | Yes |
| 14 | **PostgreSQL failure** | Connection retry with backoff; circuit breaker | Failover to replica/standby; workers pause and hold jobs rather than proceeding blind. **PostgreSQL unavailable = pipeline stops** (it is the source of truth) — by design, not by accident. | `SERVICE_DEGRADED`; reads may serve from replica | Yes |
| 15 | **Object storage failure** | 5 attempts with backoff (transient 5xx/throttle) | Generation results held in worker temp and re-uploaded; if unavailable beyond threshold, the job fails and retries later. Never mark a chunk `GENERATED` without a verified successful upload (verified by returned ETag/checksum). | Progress stalls; `DEGRADED` | Yes |
| 16 | **Partial chapter completion** | N/A | Chapter assembly refuses to run on an incomplete manifest; missing chunks are re-queued; a *preview* build may be produced and is explicitly marked non-final | `CHAPTER_INCOMPLETE` with the missing-chunk count | Yes |
| 17 | **Model version drift** (worker loads unexpected version) | No retry | Worker quarantined and drained; affected chunks identified by lineage and re-queued | Operator alert | Yes |
| 18 | **Cancellation mid-book** | N/A | Cooperative stop at chunk boundaries; completed validated chunks retained; book resumable | `CANCELLED` with "resume" offered | Yes |

**Cross-cutting invariants:**

- No failure path may leave an artifact marked valid that is not verified present and
  well-formed in object storage.
- No failure path may mutate a locked/immutable entity.
- Every failure produces a typed error class, a user-facing message that says what to do
  next, and an operator-facing diagnostic bundle.
- A single chunk can never fail a book. Only an explicit policy threshold (e.g. >N% chunks
  unrecoverable) fails a book.

---

## 22. Development architecture

### 22.1 Local environment

Docker Compose brings up the full stack with one command:

| Service | Purpose | Notes |
| --- | --- | --- |
| `postgres` | Transactional store + pgvector | Seeded with migrations and fixtures |
| `redis` | Queues, cache, locks | Single instance in dev |
| `minio` | S3-compatible object storage | Buckets auto-created on boot; console exposed |
| `api` | Control plane | Hot reload |
| `web` | Next.js frontend | Hot reload |
| `worker-cpu` | Parse/OCR/audio/assembly | FFmpeg + OCR engine baked into the image |
| `worker-ai` | Director / narrative analysis | Points at local Ollama/vLLM **or** a hosted API by config |
| `worker-gpu` | TTS | Optional profile; requires GPU passthrough |
| `prometheus`, `grafana`, `loki` | Observability | Optional `observability` profile |

Compose **profiles** keep the default footprint small: `core` (postgres, redis, minio, api,
web), `workers`, `gpu`, `observability`.

### 22.2 Developing without a GPU

Mandatory capability, because most contributors will not have a suitable GPU:

- A **`MockTTSProvider`** implementing the full `TTSProvider` interface, generating valid
  audio of realistic duration (derived from character count and pacing) — silence, tone, or
  a fast CPU engine. It satisfies every downstream contract, so the entire pipeline through
  assembly is developable and testable on a laptop.
- Similarly, a **`MockLLMProvider`** returning schema-valid canned IR for fixture books, so
  Director-adjacent work does not require model access.
- These are development/test providers registered through the same abstraction as real ones.
  They are **never** enabled in staging or production, enforced by configuration validation
  at boot.

### 22.3 Environments

| | `development` | `staging` | `production` |
| --- | --- | --- | --- |
| Infra | Docker Compose, local | Production-shaped, smaller | Full |
| Data | Fixtures + public-domain books | Anonymized/synthetic only | Real tenant data |
| LLM | Local (Ollama/vLLM) or cheap hosted | Same provider as prod, smaller model allowed | Pinned production model version |
| TTS | Mock or single local GPU | Real GPU pool, minimal size | Autoscaled GPU pool |
| Secrets | `.env` files, never committed | Secrets manager | Secrets manager, rotated |
| Object storage | MinIO | MinIO or cloud, isolated bucket | Cloud, versioned, lifecycle-managed |
| Observability | Optional | Full | Full + alerting + on-call |
| Migrations | Auto-applied | Reviewed, applied by pipeline | Reviewed, gated, reversible |
| Mock providers | Allowed | **Forbidden** | **Forbidden** |
| Destructive ops | Free | Restricted | Audited, approval-gated |

Configuration is environment-variable driven, validated at boot against a schema; a service
**MUST** refuse to start on invalid or missing configuration rather than defaulting to
something unsafe.

### 22.4 Repository shape (structural intent, not a build spec)

A monorepo with clear package boundaries mirroring §3.1: `apps/web`, `apps/api`,
`apps/worker-cpu`, `apps/worker-ai`, `apps/worker-gpu`, and shared packages for contracts
(IR schema, event schema, error taxonomy, job types) generated or hand-maintained in **one
place** and consumed by both TypeScript and Python (JSON Schema as the neutral source of
truth for cross-language contracts). Contract duplication across languages is a known
hazard and is mitigated by generating language bindings from a single schema directory,
never by parallel hand-written definitions.

---

## 23. Technology decisions

Format: **Selected / Responsibility / Reason / Alternatives considered / Consequence.**

| # | Area | Selected | Responsibility | Reason | Alternatives considered | Architectural consequence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Frontend | **Next.js (App Router) + TypeScript** | Production workflow UI, casting, review, player | SSR for fast first paint, mature ecosystem, colocated BFF for session handling | SPA + separate BFF; Remix; SvelteKit | Frontend never talks to Redis/object storage directly; all access via `api` |
| 2 | Control-plane language | **TypeScript / Node.js** | API, orchestration, domain services | Shared types with frontend, excellent BullMQ support, strong async I/O profile | Python everywhere; Go | Two-language system; contracts must be language-neutral (§22.4) |
| 3 | AI/ML/GPU language | **Python** | Parser/OCR glue, Director LLM calls, TTS, ASR | The ML ecosystem is Python; XTTS/Kokoro/Whisper are Python-native | Node bindings to ML runtimes; separate vendor APIs | Accepted cost: cross-language contract discipline. Boundary is queues + JSON Schema |
| 4 | Python service layer | **FastAPI** | Internal HTTP for health/capabilities/preview dry-runs on AI & GPU workers | Async, typed via Pydantic, trivial OpenAPI, low overhead | Flask; gRPC; queue-only (no HTTP) | Workers expose a small control surface; **domain work still arrives via queue only** |
| 5 | Primary database | **PostgreSQL 16+** | All transactional metadata, lineage, Story Bible facts | Relational integrity for a graph-shaped domain, JSONB flexibility, pgvector, mature ops | MongoDB; MySQL; separate graph DB | One database technology; vector search co-located with relational facts |
| 6 | Vector search | **pgvector** | Semantic retrieval for Story Bible context | Avoids a second datastore at v1 scale; transactional consistency with the facts it indexes | Qdrant; Weaviate; Pinecone | Swap is possible later behind the Context Service's retrieval API |
| 7 | ORM (TS) | **Prisma** | Schema, migrations, typed access in `api`/`worker-cpu` | Type safety, migration ergonomics, matches TS stack | Drizzle; Kysely; raw SQL | Prisma schema is **derived from** `database-schema.md`, never the reverse |
| 8 | DB access (Python) | **SQLAlchemy (async) with models generated/mirrored from the same contract** | Read/write for AI & GPU workers | Mature, async-capable | Raw asyncpg; HTTP-only access to `api` | Risk of drift → mitigated by narrow write surface: Python workers write only `AudioChunk`, `AudioScriptChunk`, `ProcessingAttempt`, and Story Bible deltas |
| 9 | Cache/queue store | **Redis 7+** | Queues, locks, cache, progress, pub/sub | Already needed for caching; BullMQ's substrate | Separate systems per concern | Single operational dependency; must never be a source of truth (§12.2) |
| 10 | Job queue | **BullMQ** | Commands, retries, backoff, priority, DLQ, rate limits, repeatable jobs | Native support for every §11.4 requirement; excellent TS ergonomics | Kafka; RabbitMQ; SQS; Temporal | Python workers need a compatible client/adapter (§11.1) |
| 11 | Workflow engine | **Not adopted in v1** | — | The Job Service + DAG coordination covers the need; Temporal adds significant operational surface | Temporal; Airflow; Step Functions | Re-evaluate if cross-service sagas grow beyond the current DAG |
| 12 | Object storage | **S3-compatible; MinIO in dev** | All binary artifacts | Ubiquitous API, portable across clouds and on-prem, cheap | Local filesystem; GCS-native; DB blobs | Everything binary is addressed by key; no service reads another's local disk |
| 13 | PDF/document parsing | **Marker** (primary) + a secondary extractor fallback | PDF → structured text with layout & reading order | Strong layout/structure fidelity on books; produces markdown-ish structure suited to chaptering | PyMuPDF alone; pdfplumber; Unstructured; Nougat | Parser Service must support **multiple strategies with fallback**, so no single library is load-bearing |
| 14 | EPUB parsing | **Dedicated EPUB reader over the spine/NCX** | EPUB → structure + text | EPUB already carries structure; do not OCR or re-infer what the format states | Convert EPUB→PDF→parse (lossy and absurd) | EPUB path is the highest-fidelity input and is treated as a first-class, separate strategy |
| 15 | OCR | **Tesseract** baseline, with a pluggable OCR interface allowing a higher-accuracy engine (PaddleOCR / cloud OCR / VLM-based) | Scanned pages/images → text | Free, offline, adequate for clean scans; pluggability protects against its limits on poor scans | Cloud OCR only; VLM-only | OCR is an interface, not a dependency; per-page confidence is mandatory output |
| 16 | LLM runtime | **Provider-abstracted:** local via **Ollama/vLLM** in dev, hosted API in production, both behind one `LLMProvider` interface | Narrative analysis, Director decisions | Cost control and privacy on one side, quality and reliability on the other; the abstraction lets each environment choose | Hosted-only; local-only | `director_model_version` is recorded on every artifact; switching providers is a Director version change, not a redesign |
| 17 | TTS engine | **XTTS-v2** (voice cloning, expressive) and **Kokoro** (fast, high-quality, lower cost) behind `TTSProvider` | Speech synthesis | Open-weight, self-hostable, no per-character licensing; complementary strengths (cloning vs speed) | ElevenLabs/hosted TTS; Piper; Bark | **Multi-provider from day one** — the interface is the architecture, the engines are configuration. Licensing of each model version must be verified before production use |
| 18 | ASR (QC) | **Whisper family (faster-whisper)** | Transcript verification for WER | Accurate, self-hostable, runs on the same GPU fleet | Cloud ASR; Vosk | QC is an independent job type; can run on spare GPU capacity |
| 19 | Audio processing | **FFmpeg** (+ loudnorm/EBU R128 filters) | Validation probing, normalization, silence, concat, encoding, M4B muxing with chapters | The definitive tool; handles every required container and filter | SoX; pydub; native libs | Audio workers are FFmpeg-centric; FFmpeg version is recorded in artifact lineage |
| 20 | Containerization | **Docker** (+ Compose in dev) | Reproducible runtime, GPU images | Standard; CUDA base images available | Nix; bare metal | Every service ships as an image; GPU images are large and cached on nodes |
| 21 | Orchestration (prod) | **Deferred decision** — Compose/Swarm acceptable at launch; Kubernetes when GPU autoscaling justifies it | Deployment, scaling | Avoid premature k8s complexity; nothing in the architecture depends on the choice | Kubernetes from day one; Nomad; managed PaaS | Recorded in `deployment-architecture.md`; scaling contract (§20.4) holds either way |
| 22 | Metrics | **Prometheus** | Metric collection & alerting | De facto standard, pull-based, works with GPU exporters | Datadog; CloudWatch | Every service exposes `/metrics`; metric names are a contract |
| 23 | Dashboards | **Grafana** | Visualization, per-book and fleet views | Native Prometheus + Loki integration | Kibana; vendor dashboards | — |
| 24 | Logs | **Loki** | Log aggregation, correlated by `trace_id`/`book_id` | Cheap, label-based, pairs with Grafana | ELK; vendor | Structured JSON logging is mandatory (§17.1) |
| 25 | Tracing | **OpenTelemetry** | Distributed traces across HTTP and queue hops | Vendor-neutral, both TS and Python SDKs mature | Vendor-specific agents | Trace context **must** be carried in job envelopes, not just HTTP headers |
| 26 | Contract schemas | **JSON Schema** as the neutral source; TS types and Pydantic models generated from it | IR, events, job payloads, error taxonomy | Single definition consumed by both languages; prevents drift | Protobuf; duplicated hand-written types | Contract changes are a schema-repo change reviewed under §27 |
| 27 | Auth | **Self-hosted JWT/session auth** in v1, OIDC-ready | Identity | Avoids external dependency for a single-tenant-ish launch; OIDC hooks preserved | Auth0/Clerk; Keycloak | Auth Service boundary makes a later swap contained |

**Explicitly rejected for v1:** Kafka (§11.1), a dedicated vector database (#6), a workflow
engine (#11), microservice-per-entity decomposition (§3.3), GraphQL (REST + typed contracts
is sufficient and simpler to version), and any hosted TTS as the primary engine (cost and
control).

---

## 24. Service communication

### 24.1 Synchronous (HTTP/internal API) — when an answer is needed *now*

Permitted for: authentication/authorization checks; CRUD and reads of metadata; character
reference resolution during a Director run (fast, cached); voice binding resolution; context
bundle retrieval; job status/progress reads; worker capability/health queries; presigned URL
issuance.

Rules:
- Every synchronous call has a **timeout**, a **retry budget** (idempotent GETs only), and a
  **circuit breaker**.
- No synchronous call chain may exceed **two hops** (gateway → service → service). Deeper
  chains indicate a boundary error.
- Synchronous calls never trigger expensive work; they may only *enqueue* it and return a
  handle.
- A synchronous dependency's unavailability must degrade gracefully (§3.2.10) or fail fast —
  never hang.

### 24.2 Asynchronous (queues/events) — everything expensive

Mandatory for: parsing, OCR, normalization, structural and narrative analysis, all LLM
calls, all TTS calls, validation, audio processing, assembly, encoding, notifications,
bulk operations, and any fan-out over chapters or chunks.

Rules:
- **Commands** target one consumer and carry an idempotency key (§11.2).
- **Events** are broadcast facts; producers know nothing about consumers (§11.3).
- A service **MUST NOT** publish a command into another service's private queue as a way of
  reaching into its internals; commands are part of the published contract in
  `event-contracts.md`.
- Payloads carry identifiers and object keys, never bulk content.
- Trace context propagates through the envelope.

### 24.3 Boundary summary

```
Browser ──HTTP──► API Gateway ──HTTP──► Control-plane services
                                   │
                                   └──enqueue──► Redis/BullMQ ──► Workers
Workers ──object keys──► S3/MinIO ◄── Workers
Workers ──events──► Redis ──► Notification / Job Service / Book Service
Director ──HTTP(sync, cached)──► Context, Character, Voice services
Director ──HTTP──► LLM runtime (no tools, no writes)
GPU worker ──reads only IR + voice artifact──► synthesizes ──► object storage
```

**Forbidden by contract:** the frontend touching Redis or object storage directly (beyond
signed URLs); any worker reading another service's tables; the TTS worker calling the
Director, Character, Story Bible, or Book services; the Director invoking a TTS worker
directly rather than through the queue; any service holding a synchronous request open
while an LLM or TTS model runs.

---

## 25. API architecture — principles only

The full specification is `docs/architecture/api-specification.md`. This section binds it.

### 25.1 Style and conventions

- **REST over HTTP/JSON**, resource-oriented. Nouns, plural, kebab-free lowercase:
  `/books`, `/books/{bookId}/chapters`, `/voice-profiles`.
- Sub-resources express containment only one level deep where practical; deeper relations
  are expressed as filtered top-level collections.
- Actions that are not CRUD are modelled as **sub-resource commands** that create a job:
  `POST /books/{id}/generation` returns a job handle; never `POST /doStuff`.
- HTTP verbs used correctly; `PATCH` for partial updates with explicit field semantics.
- JSON only. `snake_case` **or** `camelCase` chosen once in the API spec and applied
  universally — the spec decides; no mixed casing (open question Q7).

### 25.2 Versioning

- URL-prefixed major version: `/api/v1/...`. Breaking changes require a new major version;
  additive optional fields do not.
- Payload schema versions (IR, events) are independent of the API version and are carried in
  the payload.
- Deprecation is announced via a `Deprecation`/`Sunset` header and documented; no silent
  removals.

### 25.3 Pagination, filtering, sorting

- **Cursor-based** pagination by default (`limit` + `cursor`), because chunk and job
  collections are large and mutating; offset pagination only where a stable snapshot is
  guaranteed.
- Responses carry `data[]` plus `page: { next_cursor, has_more, limit }`. Total counts are
  optional and explicitly requested (they are expensive).
- Filtering via explicit, allowlisted query parameters (`?status=FAILED&chapter_id=...`).
  No free-form query languages, no client-supplied SQL fragments.
- Sorting via `sort=field:asc|desc` restricted to an allowlist of indexed fields.

### 25.4 Authentication & authorization in the API

Bearer token or session cookie; every endpoint declares its required scope and its resource
ownership rule; deny by default; `401` for unauthenticated, `403` for unauthorized, and
**`404` where revealing existence would leak information across tenants**.

### 25.5 Validation

Request bodies validated against a schema at the edge; unknown fields rejected (strict
mode) to prevent silent typos; all identifiers validated for format and ownership;
validation errors return a machine-readable, field-scoped error list.

### 25.6 Error format

A single envelope across every endpoint and every service:

```
{
  "error": {
    "code": "VOICE_PROFILE_LOCKED",        // stable, documented, machine-readable
    "message": "...",                       // human-readable, safe to display
    "details": [ { "field": "...", "issue": "..." } ],
    "request_id": "...",
    "trace_id": "...",
    "retryable": false,
    "documentation_url": "..."
  }
}
```

Error codes come from a **shared taxonomy** owned by the contracts package. HTTP status is
used correctly and consistently; no `200` responses carrying failures.

### 25.7 Idempotency

All unsafe, expensive, or side-effecting `POST`s accept an `Idempotency-Key` header; the
server stores the key with its response for a documented window and replays the same
response on retry. Mandatory for: upload finalization, job creation, generation start,
voice version creation, and assembly requests.

### 25.8 Job, upload, and progress endpoints

- **Job endpoints:** creating work returns `202 Accepted` with a job resource
  (`job_id`, `status`, `links.self`). Jobs are readable, cancellable, and listable, scoped by
  resource. Job state names match §16 exactly — the API does not invent its own vocabulary.
- **Upload endpoints:** two-phase — request an upload target (presigned/multipart) → client
  uploads directly to object storage → finalize. Bytes never pass through the API.
- **Progress endpoints:** a polling endpoint returning aggregated progress **and** a
  streaming channel (SSE preferred over WebSockets for one-way progress). Progress is
  computed from completed units and includes per-stage breakdown, counts of failed/flagged
  units, and an estimate with an explicit confidence, never a fabricated ETA.
- Long-running work is **never** exposed as a blocking request. No endpoint may exceed the
  gateway's request timeout by design.

### 25.9 What the API specification must not do

It must not introduce entities absent from §4, invent job states absent from §16, use event
names absent from §11.3, or define persistence details (those belong to
`database-schema.md`).

---

## 26. Document hierarchy and authority

```
docs/
└── architecture/
    ├── context.md                      ← Tier 0: root authority (this document)
    ├── api-specification.md            ← Tier 1: external HTTP contract
    ├── database-schema.md              ← Tier 1: persistence contract
    ├── event-contracts.md              ← Tier 1: async/job/event contract
    ├── director-specification.md       ← Tier 2: Director subsystem behavior
    ├── audio-script-ir.md              ← Tier 2: IR schema (binds Director ↔ TTS)
    ├── tts-provider-specification.md   ← Tier 2: TTSProvider interface & adapters
    └── deployment-architecture.md      ← Tier 2: environments, topology, scaling, config
```

### 26.1 Authority rules

1. **`context.md` is supreme.** It defines entities, boundaries, principles, and vocabulary.
   Every other document inherits from it.
2. **Tier 1 documents are the contracts of record for their surface.** `api-specification.md`
   is the only authority on endpoints, payloads, status codes, and error codes.
   `database-schema.md` is the only authority on tables, columns, types, indexes, and
   migrations. `event-contracts.md` is the only authority on queue names, job payloads,
   event names, and event schemas.
3. **Tier 2 documents specify subsystem behavior** and may not contradict Tier 0 or Tier 1.
   `audio-script-ir.md` owns the IR's concrete schema, but the IR's *role and mutability
   rules* come from §7 here.
4. **Conflict resolution:** Tier 0 > Tier 1 > Tier 2. A lower-tier document that contradicts
   a higher tier is a **defect in the lower document** — it is not evidence that the higher
   document should change. Resolving it requires a change-control task (§27), not an edit.
5. **Vocabulary is global.** An entity, state, event, or field named here keeps that exact
   name in every document and in code. Synonyms are forbidden.
6. **No orphan contracts.** Anything a service depends on must be written down in one of
   these documents. "It's in the code" is not a contract.

### 26.2 Document dependency order

`context.md` → `database-schema.md` + `event-contracts.md` + `audio-script-ir.md` →
`api-specification.md` → `director-specification.md` + `tts-provider-specification.md` →
`deployment-architecture.md`. Writing a downstream document reveals gaps upstream; those
gaps are fixed **upstream first**, then propagated.

---

## 27. Change control

### 27.1 Protocol

Every architectural change follows these seven steps, in order, before any code is written:

1. **Identify the affected contract(s).** Name the document(s) and section(s).
2. **State why the change is required.** A concrete problem, a measurement, or a new
   requirement — not aesthetics, not "cleaner."
3. **Identify downstream impact.** Which services, documents, tables, events, IR fields,
   stored artifacts, and *already-generated audio* are affected. Explicitly state whether
   existing artifacts remain valid.
4. **Update the authoritative document** at the highest affected tier first.
5. **Update dependent contracts** in dependency order (§26.2).
6. **Verify implementation compatibility.** Migration path, backward compatibility, whether
   a version bump (schema, Director, IR, API) is required, and what happens to in-flight
   jobs and existing books.
7. **Record the decision** as an ADR (see below) and link it from the changed document.

### 27.2 Architecture Decision Records

Location: `docs/architecture/decisions/NNNN-short-title.md`. Each ADR records: context,
decision, status (`proposed | accepted | superseded by NNNN`), consequences, alternatives
considered, and affected contracts. ADRs are append-only; superseding is explicit.

### 27.3 Frozen contracts

Once implementation of a phase begins, its contracts are **frozen** for that phase. Frozen
contracts change only through §27.1. A contract is never changed silently, never changed
"while I was in there," and never changed by code that diverges from the document.

### 27.4 Change classes

| Class | Examples | Requires |
| --- | --- | --- |
| **Additive** | New optional IR field, new event, new endpoint | ADR + document update; minor version |
| **Behavioral** | Changed default, changed retry policy, new validation rule | ADR + impact statement + document update |
| **Breaking** | Renamed field, removed state, changed entity ownership, new required field | ADR + migration plan + major version + explicit approval |
| **Structural** | New service, new datastore, replaced infrastructure | ADR + `context.md` update + deployment update + explicit approval |

---

## 28. Rules for Claude Code

These rules are binding on every future implementation session in this repository.

1. **Read the architecture documents before implementation.** At minimum `context.md` plus
   every Tier 1 document relevant to the phase. Do not begin coding from the task prompt
   alone.
2. **Treat the architecture documents as authoritative contracts.** Where code and document
   disagree, the document is right and the code is a defect — unless a §27 change has been
   approved.
3. **Never invent architecture.** No new services, datastores, queues, patterns, entities,
   states, events, or abstractions that are not in the documents. If something is missing,
   stop and report it (rule 13).
4. **Never rename existing fields, entities, states, events, queues, or error codes**
   without an approved contract change. Names are contracts; "clearer" is not a reason.
5. **Never redesign an API because another design appears cleaner.** Implement
   `api-specification.md` exactly, including status codes, error codes, pagination shape,
   and casing.
6. **Never modify database structure outside `database-schema.md`.** No ad-hoc columns, no
   convenience tables, no index changes, no migrations that the schema document does not
   describe.
7. **Never bypass service boundaries.** No cross-service table access, no direct calls that
   skip an owning service, no engine-specific logic outside a provider adapter. If a
   boundary genuinely blocks the task, document the reason and report it before proceeding.
8. **Implement only the requested phase.** Do not build ahead, do not "while I'm here"
   refactor unrelated code, do not implement future-phase features speculatively.
9. **Reuse existing shared services and abstractions.** Check the shared contracts package,
   the existing repositories/clients, the error taxonomy, and the job/queue helpers before
   writing anything new. Duplicated contract definitions are a defect.
10. **Add tests for all behavior.** Unit tests for logic, contract tests for every published
    interface (API, IR, events, `TTSProvider`), integration tests for pipeline stages, and
    fixtures for at least one small public-domain book. Tests assert the contract, not the
    implementation's current behavior.
11. **Run lint, typecheck, and tests** (TypeScript and Python) before declaring anything
    done. Report the actual results, including failures. Never claim verification that was
    not run.
12. **Perform a self-audit before declaring a phase complete**, explicitly checking: contract
    conformance, boundary violations, missing persistence, missing lineage/versioning,
    synchronous blocking operations, missing idempotency, missing error handling, missing
    tenant scoping, and missing observability instrumentation.
13. **Report architectural conflicts instead of silently resolving them.** When the documents
    are ambiguous, contradictory, or silent on something the task requires, stop and state
    the conflict with the affected sections and the options — do not pick one and proceed.
14. **Never proceed with contradictory assumptions.** If two parts of a task cannot both be
    true, that is a blocking question, not something to average out.
15. **Preserve backward compatibility where the architecture requires it** — in particular
    for the IR schema, event schemas, the public API, and any artifact lineage that existing
    audiobooks depend on. Never invalidate previously generated audio as a side effect.

Additional standing rules specific to this system:

16. **Never make TTS smart.** If a task tempts a TTS worker to read the book, the Story
    Bible, or the Character Registry, the design is wrong — the missing information belongs
    in the IR.
17. **Never mutate a locked voice version or a generated artifact.** Create a new version.
18. **Never send the whole book to an LLM.** Use the Context Service's bundle API.
19. **Never run an LLM, TTS, OCR, or FFmpeg call inside an HTTP request handler.**
20. **Never log book text at info level, and never log secrets, tokens, or signed URLs.**

---

## 29. Phase-based development

Phases are sequential; each depends on the contracts and capabilities of those before it.
**This document defines their purpose and dependencies only. No phase is implemented here.**

| Phase | Name | Architectural purpose | Depends on | Exit criteria (architectural) |
| --- | --- | --- | --- | --- |
| **0** | Architecture & contracts | Produce and freeze `context.md` and the Tier 1/2 documents | — | All eight documents exist, are internally consistent, and are reviewed |
| **1** | Infrastructure & foundation | Monorepo, Compose stack, shared contracts package, config validation, logging/metrics scaffolding, CI (lint/typecheck/test) | 0 | Stack boots; a trivial job flows end-to-end through the queue; observability emits |
| **2** | Authentication & users | Auth Service, User Service, tenancy primitives, the shared tenant-scoped data-access layer | 1 | A user can register, log in, and no query can escape its tenant scope |
| **3** | Book ingestion | Upload lifecycle, validation, quarantine, `BookFile`, object-storage key contract, `book.uploaded` | 2 | Untrusted files are safely admitted or rejected; bytes never traverse the API |
| **4** | Parsing & normalization | Parser Service, format strategies, OCR, canonical text, `content_hash`, text QC (§14.1) | 3 | A PDF, an EPUB, and a scanned set all yield canonical text with provenance and confidence |
| **5** | Structural analysis | Chapter/Section/Paragraph spine, front/back matter, reading order, structure QC | 4 | A book has a stable, versioned, reviewable structure |
| **6** | Story Bible & Character Registry | Narrative Understanding, Story Bible persistence, `NarrativeState` snapshots, context bundle API, character identity & resolution | 5 | Context bundles are budgeted, provenance-bearing, and cacheable; references resolve to stable IDs with confidence |
| **7** | Director & Audio Script IR | Director Service, IR generation, IR validation (§14.2), coverage invariant, versioning | 6 | Every chapter yields a validated IR whose chunk text exactly reconstructs the source |
| **8** | Voice Registry & previews | Voice profiles/versions, assignment, preview workflow, approval, lock (§9, §15) | 7 (+ minimal 9 for preview rendering) | Generation is gated on approved casting; locked versions are provably immutable |
| **9** | TTS GPU workers | `TTSProvider` abstraction, XTTS + Kokoro adapters, mock provider, worker lifecycle, lineage recording | 7, 8 | A chunk renders from IR alone; swapping providers requires no change outside the adapter |
| **10** | Audio validation & processing | Technical QC, loudness, pause application, ASR verification scaffolding | 9 | Bad audio is caught and regenerated at chunk granularity |
| **11** | Chapter & audiobook assembly | Deterministic assembly, chapter markers, M4B/metadata/cover, voice-consistency verification | 10 | A complete, playable, correctly-chaptered audiobook with verified voice consistency |
| **12** | Job orchestration & progress | Full state machine, DAG coordination, cancellation, resumption, DLQ, progress aggregation | 1–11 | A book survives worker crashes, cancellation, and resumption without losing valid work |
| **13** | Frontend production workflow | Upload, structure review, cast review, voice preview/approval, progress, QC review surface | 12 | A user can drive a book end-to-end without operator intervention |
| **14** | Streaming & download | Signed URLs, range requests, player, download formats | 11, 13 | Authorized delivery with no public object access |
| **15** | Observability & production hardening | Full metrics/traces/dashboards/alerts, cost accounting, autoscaling, backups & restore drills | 12 | Cost per audiobook is measured; a book is fully traceable by `book_id` |
| **16** | Security & QA | Threat-model review, pen-test items, rate limits, sandbox hardening, prompt-injection tests, load tests, full ASR QC | all | §18 is verified by tests, not by assertion |

Phases 8 and 9 have a controlled circular dependency: previews need a renderer. It is
resolved by implementing the **mock provider first** in Phase 9's scaffolding (or in Phase
1's contracts package), so Phase 8 can be built and tested before real GPU work exists.
This is the only permitted phase-order exception and it is deliberate.

---

## 30. Internal architecture consistency review

Performed against the acceptance criteria. Findings and resolutions:

### 30.1 Circular dependencies

| Candidate cycle | Verdict | Resolution |
| --- | --- | --- |
| Director → Voice Service → TTS → Director | **Broken.** TTS never calls the Director. Voice previews are requested by the Voice Service via the queue and return via events. | OK |
| Voice preview (Phase 8) ↔ TTS worker (Phase 9) | **Real, and acknowledged.** | Mock provider implemented first (§22.2, §29). Interface, not implementation, is the dependency. |
| Director → Context Service → (deltas written by) Director | **Not a cycle in a single request.** The Director *reads* a bundle synchronously and *writes* deltas asynchronously afterwards. Read and write are separated in time and mechanism. | OK — documented in §3.2.7/§3.2.10 |
| Character Service → Story Bible → Character Service | **Broken by ownership:** Character owns identity rows; Story Bible references them by ID and owns narrative facts. No write-back loop. | OK |
| Job Service → workers → Job Service | **Intentional and acyclic in data terms:** Job Service commands, workers report state. State authority is one-directional. | OK |

### 30.2 Conflicting ownership

- `Scene` was initially ambiguous between Book Service (structure) and Story Bible
  (semantics). **Resolved:** Book Service owns the `Scene` *row and boundaries*; the Context
  Service owns scene *semantics* (mood, participants, summary) stored in the Story Bible and
  referenced by `scene_id`. One writer per field group.
- `AudioChunk` is written by TTS workers but conceptually orchestrated by the Job Service.
  **Resolved:** TTS Service owns the entity; the Job Service owns `ProcessingJob`/
  `ProcessingAttempt` only. The write surface for Python workers is explicitly enumerated
  (§23 row 8).
- `Character → VoiceProfile` assignment could have been owned by either service.
  **Resolved:** Voice Service owns the assignment (it is a voice concern), keyed by
  `character_id`. Character Service never writes voice data.
- Pronunciation lexicon (Story Bible) vs pronunciation hints (IR). **Resolved:** lexicon is
  book-scoped state owned by the Context Service; hints are per-chunk annotations owned by
  the Director (§6.4).

### 30.3 Unclear service responsibilities

- Normalization and structural analysis were unassigned in the initial pipeline sketch.
  **Resolved:** both live in the Parser Service (§3.2.6), which is renamed in intent to
  "document understanding," with structure rows handed to the Book Service.
- Narrative Understanding was implied but had no home. **Resolved:** it is a module inside
  `worker-ai` with its own job types, sharing the Director's runtime but not its
  responsibilities (§3.1, §3.3).
- Audio validation vs audio processing overlapped. **Resolved:** validation *judges* and
  never modifies; processing *modifies* and never judges (§3.2.13, §14.3).

### 30.4 Missing state transitions

Added during review:
- `BLOCKED` state on `ProcessingJob` — previously there was no way to represent "waiting on
  cast approval" without abusing `QUEUED` (§16.1).
- `DEAD_LETTERED` as a distinct terminal state, separate from `FAILED`, so DLQ pressure is
  observable and replay is a defined operation (§16.1).
- `NEEDS_REVIEW` as a non-terminal book state reachable from any active state (§4.4) — QC
  findings previously had no lifecycle home.
- `SUPERSEDED` on `AudioChunk`, `AudioScriptChunk`, `ChapterAudio`, `Audiobook` — required
  by immutability (§2.5) and previously implicit.
- `RETIRED` on `VoiceProfileVersion`, distinguished from deletion (§9.2).

### 30.5 Missing persistence

Added during review:
- `context_bundle_hash` on IR chunks — without it, a Director decision is not explainable
  and §2.4 determinism is unverifiable.
- `seed` and `generation_params_hash` as first-class fields on the chunk and the audio
  lineage.
- `ModelVersion` as a real entity rather than a string, so OCR/LLM/TTS/ASR/FFmpeg versions
  are referenceable and joinable.
- Per-block OCR confidence, persisted — QC (§14.1) depends on it.
- `capability_gap` records on generated chunks (§10.3), so approximations are auditable.
- Idempotency-key registry with a retention window (§16.3).
- Alias validity ranges and speaker-scoped aliases (§8.2) — needed for "the Queen from
  chapter 20" and "what Ben calls Alice."

### 30.6 Synchronous blocking operations

Audited: no HTTP path invokes an LLM, TTS, OCR, or FFmpeg (§2.3, §24.1). Two near-misses
resolved:
- **Director single-chunk preview** for the UI: kept synchronous but explicitly bounded,
  rate-limited, and flagged as a dry run that produces no persisted artifact (§3.2.7).
- **Context bundle retrieval** is synchronous and on the Director's critical path; it is a
  database + cache read with a hard timeout and a documented degraded response, never a
  model call (§3.2.10).

### 30.7 Non-versioned voice state

Audited: `VoiceProfileVersion` is immutable once used, versioned monotonically, referenced
by ID+version in both IR and audio lineage, and validated at assembly time (§9.1). Reference
audio participates in version identity by hash, so swapping the audio file without a version
bump is impossible. System-library voices are snapshotted per tenant so upstream changes
cannot reach existing audiobooks (§19.1).

### 30.8 Non-reproducible TTS generation

Audited. Honest position stated in §2.4: **contract determinism is guaranteed; bit-exact
model determinism is not**, and nothing in the system depends on the latter. Every audio
artifact carries the full lineage tuple including seed and params hash, so any output can be
explained and re-rendered to a perceptually identical result on comparable hardware.
Regeneration always creates a new version rather than replacing bytes.

### 30.9 Missing job recovery

Audited against §16.5 and §21: orphan reaping via heartbeat + fencing tokens, queue/DB
reconciliation on restart, idempotent re-delivery, DLQ replay, cooperative cancellation with
retained partial work, and chunk-granularity regeneration (§16.4). Two gaps closed during
review: fencing tokens on locks (a reaped worker could otherwise write a stale result), and
the rule that a chunk is never marked `GENERATED` before its upload is verified by checksum
(§21 row 15).

### 30.10 Responsibility leakage between documents

- Endpoint paths, status codes, and payload shapes were pruned from §25; only principles
  remain, with concrete design delegated to `api-specification.md`.
- No columns, types, indexes, or Prisma syntax appear in §4 — only entities, meaning,
  lifecycle, ownership, and versioning obligations.
- Concrete IR field types, enum members, and JSON examples are deferred to
  `audio-script-ir.md` and `director-specification.md`; §6–§7 define role, structure, and
  mutability.
- Loudness targets, retention windows, timeouts, concurrency numbers, and topology are
  deferred to `deployment-architecture.md` as configuration, not baked into architecture.
- Queue names, event payload schemas, and job envelope fields are named here but specified
  in `event-contracts.md`.

### 30.11 Remaining known tensions (accepted, documented)

1. **Two languages, one contract set.** Mitigated by JSON Schema generation (§22.4, §23 #26),
   but drift remains the highest-probability long-term defect source. Contract tests in both
   languages are mandatory (rule 10).
2. **Python workers writing to PostgreSQL directly** trades boundary purity for practicality;
   the write surface is deliberately narrow and enumerated (§23 #8). If it widens, extract a
   write API.
3. **Sequential narrative analysis caps per-book throughput** (§5.5). Accepted: quality of
   long-form context is the product. Cross-book parallelism provides fleet throughput, and
   the deferred two-pass design (§5.5) is the escape hatch.
4. **Intermediate WAV storage is the dominant storage cost.** Accepted for regenerability;
   controlled by lifecycle policy (§12.3).
5. **Chunk-level rows scale to millions per tenant.** Partitioning by book is anticipated but
   deferred to `database-schema.md`.

---

## Appendix A — Vocabulary (binding)

| Term | Meaning |
| --- | --- |
| **Chunk** | One renderable performance unit: an `AudioScriptChunk` and the `AudioChunk` it produces. The atomic unit of generation, retry, and regeneration. |
| **Spine** | The canonical reading order of a book: chapters → sections → scenes → paragraphs. |
| **Director** | The intelligence layer deciding *how* text is performed. Never renders audio. |
| **Audio Script IR** | The contract between narrative intelligence and TTS generation. |
| **Story Bible** | The persistent narrative knowledge store for one book. |
| **Context bundle** | A budgeted, ranked, provenance-bearing set of context layers for one Director request. |
| **Lineage** | The tuple of source hash and versions that explains and reproduces an artifact. |
| **Casting** | Assigning and approving voice profiles for a book's characters. |
| **Locked** | Immutable because it has been used to produce retained output. |
| **Superseded** | Replaced by a newer version, retained for audit and rollback. |
| **Provider** | An adapter implementing `TTSProvider` or `LLMProvider`; the only place engine-specific logic may exist. |
| **Review item** | A QC finding attached to a book, typed, actionable by a human. |

## Appendix B — Document status

| Field | Value |
| --- | --- |
| Version | `context.v1.1` |
| Status | DRAFT — awaiting human review |
| Frozen | No. Freezes when Phase 1 begins. |
| Change protocol | §27 |
| Corrections in `v1.1` | §6.3's closed-enumeration list no longer includes pacing (a self-contradiction flagged by `audio-script-ir.md` IR-7 and `director-specification.md` DIR-1, both already using the numeric treatment §6.2/§7.2 fix). No entity, event, or contract semantics changed. See `architecture-review.md`'s Blocker Closure Addendum |
| Next documents | `database-schema.md`, `event-contracts.md`, `audio-script-ir.md`, then `api-specification.md`; `deployment-architecture.md` now exists as of this revision (`architecture-review.md` BLOCKER-2, closed) |

