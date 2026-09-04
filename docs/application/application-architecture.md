# Application Architecture — the layer above the audiobook engine

> **Status:** Phase 8. Describes what is implemented, not what is planned.
> Where something is specified but unbuilt, this document says so and names the
> finding rather than describing it as if it existed.

---

## 1. What this layer is

Phases 1–7 built and validated the audiobook engine: ingestion, narrative
understanding, the Director, the TTS runtime, assembly, and mastering. Phase 8
adds the layer a user — and therefore a frontend — actually talks to.

```
                        USER / FRONTEND
                              │
                              ▼
                  ┌───────────────────────┐
                  │   APPLICATION API     │  /api/v1/**  (layer 1)
                  │   guards · validation │
                  │   idempotency · audit │
                  └───────────┬───────────┘
                              ▼
                  ┌───────────────────────┐
                  │  STAGE COMMANDS +     │  persist intent, enqueue, 202
                  │  JOB / PROGRESS       │  read models over persisted state
                  └───────────┬───────────┘
                              ▼
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  INGESTION              DIRECTOR                   TTS
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
                          ASSEMBLY
                              ▼
                          AUDIOBOOK
                              ▼
                     ARTIFACT + ACCESS URL
```

The application layer **calls** the engine; it never reimplements it. There is
no speaker resolution, no Director logic, no TTS parameter mapping, and no
audio assembly in `apps/api`. Where two surfaces need the same derivation —
`GET /books/{id}/progress` and `GET /books/{id}?include=stages` — one service
produces both, so they cannot disagree.

---

## 2. The "project" question, answered

The Phase 8 brief asks for a user-facing **Project**. This architecture already
has one, and it is called **`Book`**.

`api-specification.md` §4.1 defines the public resource tree with `Book` as the
top-level workspace: source files, chapters, characters, story bible, audio
script, audio chunks, chapter audio, audiobooks, progress, and events all hang
off `/api/v1/books/{bookId}`. The tree closes with a binding rule: _"Every path
above maps to an entity in `context.md` §4.2 … No entity is invented."_

There is an `audiobook_project` in the contract (§20.10), but it is a **derived
read model** over `Audiobook` + `book.status` + the `chapter_audio` set —
`database-schema.md` §4325 lists it as `derived`, and §2206 explains why it is
not stored (`STALE` is a comparison, and a stored copy would itself go stale).
It is the response shape of `GET /books/{id}/audiobook`, not a workspace.

**Decision: `Project` ≡ `Book`. No new entity, no new table, no new
vocabulary.** Inventing a `Project` row above `Book` would have created a
second workspace identity with no owner service, duplicated `Book`'s lifecycle,
and broken every `book_id` foreign key's meaning. This is recorded as a
resolved naming difference in the Phase 8 contract audit, not a schema gap.

Everywhere below, "project" means the `Book` aggregate.

---

## 3. Project lifecycle

The lifecycle vocabulary is `Book.status` (`api-specification.md` §20.1,
`context.md` §4.4) — sixteen states, closed, not extensible within v1:

```
CREATED → UPLOADED → PARSING → PARSED → STRUCTURED → ANALYZING → ANALYZED
        → CASTING → SCRIPTING → SCRIPTED → GENERATING → ASSEMBLING → COMPLETED
```

Cross-cutting, reachable from any active state: `FAILED`, `CANCELLED`,
`NEEDS_REVIEW`. `NEEDS_REVIEW` is **not terminal** — it awaits a human decision
and returns to the pipeline.

**There is no `ARCHIVED` state.** `context.md` §4.1 mandates soft deletion via
`deleted_at` and §4.4 defines no archive state, so "archive" is not a concept
in this API. `DELETE /books/{id}` stamps `deleted_at`; the book leaves
`GET /books` unless `include_deleted=true`, and its artifacts are retained for
the retention window.

### Who moves the status

Only the engine. `status` is absent from the `PATCH /books/{id}` request schema,
so an attempt to set it is `422 unknown_field` at the validation pipe. Pipeline
state changes because work happened, never because a client asked.

### Transition validity

Invalid operations are refused at the point of the operation, by the service
that owns the precondition — not by a central state-machine table that would be
a second source of truth. Examples, all pre-existing and all still enforced:

| Attempt                                                    | Refusal                          |
| ---------------------------------------------------------- | -------------------------------- |
| `POST .../tts` with no validated Audio Script              | `409 AUDIO_SCRIPT_NOT_VALIDATED` |
| `POST .../tts` with unresolved character voices            | `409 CASTING_INCOMPLETE`         |
| `POST .../tts` against an unapproved voice version         | `409 VOICE_PROFILE_NOT_APPROVED` |
| `PATCH .../books/{id}` changing `language` after ingestion | `409 INVALID_STATE_TRANSITION`   |
| `DELETE .../books/{id}` with live jobs                     | `409 BOOK_HAS_ACTIVE_JOBS`       |

---

## 4. Workflow orchestration

### The command shape

`api-specification.md` §4.3 fixes one command shape for the whole public API:

```
POST /api/v1/books/{bookId}/{stage}    → validate, persist intent, enqueue, 202 + job handle
GET  /api/v1/books/{bookId}/{stage}    → the current and historical state of that stage
```

The five stages are `ingestion`, `analysis`, `director`, `tts`, `assembly`.
There is no `POST /doStuff`, no RPC verb in a path, and no second way to start
the same work. Chunk- and chapter-level regeneration are **scoped invocations
of the same endpoint** (`scope: CHAPTERS | CHUNKS | FILTER`), which is what
structurally guarantees that one contract regenerates one chunk, one chapter, or
a book.

### Job hierarchy

```
Book
 └── coordinator ProcessingJob        (one per stage invocation)
      └── worker ProcessingJob        (one per unit — chunk, chapter, page)
           └── ProcessingAttempt      (one per try; immutable)
                └── artifact          (AudioChunk, ChapterAudio, Audiobook, …)
```

A user interacts with the **coordinator** handle returned by the `202`. Worker
jobs are visible through `GET /jobs?book_id=…` for diagnosis, but nothing
requires a client to manage them individually: cancelling the coordinator
cascades, and progress aggregates.

`TTSJob` is deliberately **not** a public resource (§4.2). The public job
vocabulary is `ProcessingJob`, and the API does not invent a second one.

### Asynchrony is absolute

Every stage command returns `202 Accepted` with a job handle. §9.3 defines what
that means and does not mean: _"the request was validated, intent was persisted,
work was enqueued, and a job handle exists. It asserts nothing about the work."_
A `202` body carrying `"status": "SUCCEEDED"` is a contract violation, and
acceptance status is restricted to `CREATED | QUEUED | BLOCKED`.

No API request waits on an LLM, a GPU, or ffmpeg.

---

## 5. Status model

Three distinct vocabularies, none of which is derived from the others by
guesswork:

| Vocabulary                        | Owner                  | Where                                                        |
| --------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `Book.status`                     | Book service           | `GET /books/{id}`                                            |
| `ProcessingJob.status` (9 states) | Job service            | `GET /jobs/{id}`                                             |
| Stage states (§20.5)              | **derived read model** | `GET /books/{id}/progress`, `GET /books/{id}?include=stages` |

Stage states are a _projection for clients_, not a second state machine
(§20.5). The projection is implemented once, in `ProgressService`, and it never
reports `COMPLETED` on the strength of job state alone: a job can succeed while
producing nothing, so completion is always confirmed against entity state.

The one place this matters most: a `DRAFT` Audio Script whose generating job
succeeded reports `director: VALIDATING`, not `COMPLETED`. Reporting
`COMPLETED` would tell a client the script is usable when `POST .../tts` will
refuse it.

---

## 6. Progress model

`GET /api/v1/books/{bookId}/progress` (§16.19). Three properties, each of which
a naive implementation gets wrong:

**1. Every number is measured.** `progress = completed_units / total_units`
over rows that exist:

| Stage     | Unit    | Numerator                                            | Denominator                    |
| --------- | ------- | ---------------------------------------------------- | ------------------------------ |
| ingestion | page    | `parsed_page` in `OK` + `NEEDS_REVIEW`               | `book_version.pages_total`     |
| analysis  | scene   | `scene_semantics` rows                               | `scene` rows                   |
| director  | script  | `AudioScript.state = VALIDATED`                      | the script itself              |
| tts       | chunk   | `audio_chunk` in `GENERATED`/`VALIDATED`/`ASSEMBLED` | **`audio_script_chunk` count** |
| assembly  | chapter | `chapter_audio` in `ASSEMBLED`                       | `chapter` count                |

The existence of a job is never evidence that work happened.

**2. Unknown is `null`, never `0`.** When a denominator does not exist yet — no
script has been generated, so nobody knows how many chunks TTS will render —
`total_units` and `progress` are `null`. Zero is a measurement; null is the
absence of one. `overall_progress` is the mean over stages whose denominator is
known, and `null` when none is.

**3. Progress cannot decrease.** The TTS denominator is the _script_ chunk
count, not the audio-chunk count. Using the latter would report 100% after the
first chunk rendered and then fall as more were enqueued.

### ETA

```json
"estimate": { "remaining_ms": 9420000, "confidence": "LOW",
              "basis": "COMPLETED_UNIT_RATE", "computed_at": "…" }
```

`confidence` is `NONE` with `remaining_ms: null` unless there is a measured
completion rate to extrapolate from. It is capped at `LOW` and deliberately
never raised: the rate is measured against a fleet whose size and contention
this service cannot see, and calling that `MEDIUM` would be a guess about
infrastructure dressed as a measurement. §16.19: _"a fabricated ETA is a
contract violation."_

### Cost

Every figure is a `count`/`groupBy` aggregate on an indexed column, and the
**number of queries is fixed** — eleven, regardless of book size. A
100-chapter, 10 000-segment project costs the same as a one-chapter one. Rows
are never loaded, so the response is bounded too; `active_job_ids` is capped at
20 with the full list available, paginated, at `GET /jobs?book_id=…`.

Migration `0004_phase8_read_model_indexes` adds the indexes these aggregates
need. Before it, each poll was a sequential scan of the largest tables in the
system.

---

## 7. Cancellation

Cooperative, never preemptive (`context.md` §11.4, `event-contracts.md` §29).

```
POST /api/v1/jobs/{id}/cancellation        (synchronous, 200)
  → processing_job.cancellation_requested = true     (durable truth)
  → Redis flag  job:cancel:{tenant}:{job}            (fast path, 24h TTL)
  → queued job removed from BullMQ where possible
  → 200 immediately — WITHOUT claiming the work stopped

worker, at its next job boundary
  → reads the flag (Redis, falling back to the column)
  → exits before starting
  → job → CANCELLED, emits job.cancelled
```

**Not a queued command.** A `job.cancel` message would queue behind the very
work it is trying to stop; on a saturated GPU queue it might not be delivered
for hours.

### Behaviour by state (idempotent in every case)

| Current                                                | Result                                                      | HTTP  |
| ------------------------------------------------------ | ----------------------------------------------------------- | ----- |
| `CREATED` / `QUEUED` / `BLOCKED` / `RETRYING`          | → `CANCELLED`, `effective: true`                            | `200` |
| `RUNNING`                                              | `requested: true`, status unchanged, **`effective: false`** | `200` |
| `SUCCEEDED` / `FAILED` / `CANCELLED` / `DEAD_LETTERED` | no-op, original `requested_at` preserved                    | `200` |

A terminal job is `200`, **not** `409`: cancelling something already finished is
a no-op, not a conflict.

`job.cancelled` is emitted only where cancellation _took effect_. For a
`RUNNING` job the worker emits it on acknowledgement — emitting it at request
time would tell every consumer the work stopped while the GPU is still running.

### Cascade and retention

Cancelling a coordinator cancels its `CREATED`/`QUEUED`/`BLOCKED` children and
requests cancellation of `RUNNING` ones. Cancelling a child does not cancel its
parent.

**Completed work is retained.** A cancelled book keeps its finished, validated
chunks and resumes from them; cancelling at chunk 8 000 of 10 000 and resuming
renders 2 000, not 10 000.

### Known limit

The worker check is at the **job boundary** — before a processor starts, and
therefore before every retry. That is the complete requirement §29.3 states for
`generate_tts_chunk` ("before synthesis begins"). It does **not** yet cover
mid-job boundaries: cancelling a `parse_book` already on page 200 of 400 will
not stop it before page 400. The exposure is bounded by one job's duration
rather than by the book's. Recorded, not papered over.

---

## 8. Retry

There is **no public retry endpoint**, by contract (§16.18). Three distinct
mechanisms cover the three real cases:

| Case                                 | Mechanism                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Transient failure                    | The job system's own bounded retry with full-jitter backoff, then DLQ                                            |
| User wants the work redone           | A **scoped stage command** — `POST .../tts` with `scope` and `force`, which creates fresh jobs with full lineage |
| Operator replay after fixing a cause | `POST /api/v1/admin/jobs/{id}/replay` — `PLATFORM_ADMIN`, audited, `Idempotency-Key` required                    |

Replay creates a **new** job carrying the original's `correlation_id` and
pointing at it through `causation_id`. It never mutates the original: a replay
that overwrote its predecessor would destroy the evidence of why it was
dead-lettered. It is refused (`409 JOB_NOT_REPLAYABLE`) unless the job is
`DEAD_LETTERED` or `FAILED`, and refused again if the job has no recorded
dispatch envelope — inventing a payload would dispatch a job the service never
described.

A user cannot retry permanently invalid input indefinitely: the stage command
re-validates every precondition, so a book that fails admission fails again.

---

## 9. Review model

`api-specification.md` §15.18 is explicit: **Review items are "Reserved, not
specified"** — `context.md` §14.5 mandates a review surface, but no `ReviewItem`
entity exists in §4.2 (open question OQ-3). Phase 8 therefore **does not invent
one**. Review information is surfaced through the mechanisms the contract
already defines:

| Signal                        | Where                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Flagged script chunks         | `GET .../audio-script-chunks?has_review_flags=true`, `review_flags[]` per chunk                                 |
| Flagged unit counts per stage | `progress.stages[].flagged_units`                                                                               |
| Book-level review gate        | `book.needs_review`, `Book.status = NEEDS_REVIEW`                                                               |
| Low-confidence attribution    | `ReviewFlag.LOW_CONFIDENCE` / `UNKNOWN_SPEAKER` on the chunk                                                    |
| Capability degradation        | `ReviewFlag.CAPABILITY_GAP`, `audio_chunk.capability_gaps`                                                      |
| Suspicious audio              | `audio_chunk.validation_status`, `INVALID` status                                                               |
| Review actions                | `PATCH .../audio-script-chunks/{id}` (performance fields while `DRAFT`/`VALIDATED`), then a scoped regeneration |

Canonical book content is never editable through any of these — §30 of the
Phase 8 brief and the architecture agree.

**The gate remains advisory.** Architecture-review high-risk item 10 / OQ-DIR-3
records that nothing blocks generation on unreviewed flags; Phase 8 surfaces the
flags but does not change that, because making it blocking is a product decision
with no contract behind it yet. Still OPEN.

---

## 10. Artifact access

Uniform across every binary in the system (§16.20): a
`POST .../{resource}/access-urls` sub-resource mints a short-lived signed URL
against object storage.

- **No bytes pass through the application.** The API returns a URL; the client
  fetches from storage directly. A 20-hour audiobook is never buffered in
  application memory.
- **Range requests and streaming are object storage's job** — §9.1 notes `206`
  is "emitted by object storage, not by this API".
- **Expiry** defaults to 300s and is capped at 900s.
- **Storage keys and bucket names never appear in a response** (§14.8/§14.9).
- Every mint is audited as `ACCESS_URL_MINTED`.
- A `PLATFORM_ADMIN` cannot mint one at all (§6.6, enforced by `TenantRoleGuard`).

### Versioning

Artifacts are immutable and versioned: `AudioChunk.generation_version`,
`ChapterAudio.version`, `Audiobook.version`, with an `is_current` pointer.
Regeneration writes a **new** row and supersedes the old one; it never
overwrites. Historical versions stay reachable through the collection endpoints
(`GET .../audiobooks`, `GET .../audio-chunks`), so a V1 rendered before a voice
change remains byte-identical after V2 exists.

---

## 11. Authorization model

Two complementary guards, and the property that matters is the one neither can
assert alone: **no principal can reach both surfaces.**

```
JwtAuthGuard          verify RS256 bearer → {sub, tenant_id, roles, scopes}
      │
      ├── TenantRoleGuard      tenant CONTENT surfaces
      │     · requires TENANT_OWNER | TENANT_MEMBER
      │     · refuses PLATFORM_ADMIN outright  (§6.6, absolute)
      │
      └── PlatformAdminGuard   ADMINISTRATIVE surfaces
            · requires PLATFORM_ADMIN
            · refuses every ordinary tenant principal
      │
      ├── RateLimitGuard       per-bucket, per user / tenant / IP
      └── QuotaGuard           tenant entitlement on expensive work
```

Every route carries exactly one of the first two, so privilege escalation would
require changing a guard rather than forging a claim.

### Ownership and existence disclosure

Ownership is checked on **every** resource, and a cross-tenant reference is
`404`, never `403` (§6.4) — a `403` would confirm the resource exists for a
tenant the caller cannot see into. Within a tenant, a permission failure is
`403`, because existence is already known.

Tenant scoping is applied **in the query**, not to the rows afterwards: a filter
that runs after the read is one refactor away from being dropped.

### Authentication scope

This deployment verifies an externally-issued RS256 bearer token. There is no
registration, login, refresh, or MFA implementation, and `/api/v1/auth/**` and
`/users/me/sessions` are **not implemented** — the `session` and
`refresh_token` tables have no writer, so a sessions endpoint would return `[]`
in a way indistinguishable from "you have no sessions". Reported as a gap rather
than faked. See the contract audit.

---

## 12. Quotas

Enforced on the four dimensions `tenant_quota` actually defines
(`concurrent_books`, `books_total`, `storage_bytes`, `gpu_minutes_monthly`) and
no others. §44 of the Phase 8 brief is explicit — _"do not invent commercial
limits if product policy does not exist"_ — so a tenant with **no quota row is
unlimited**, which is what the absence of a policy row means in this schema.

The asymmetry that matters:

- The quota **read** (`GET /users/me/quotas`) fails **open**: `200` with
  `degraded: true` and `used: null`, so a dashboard still renders during an
  aggregator outage.
- Quota **enforcement** fails **closed**, at job creation. Showing a stale
  number costs nothing; letting an unmetered book start costs GPU hours.

`QUOTA_EXCEEDED` is a different code from `RATE_LIMITED` and is marked
non-retryable: one means "slow down" and retrying works, the other means "you
are out of allowance" and retrying just burns requests.

---

## 13. Event integration

The application layer **consumes** the existing event vocabulary; it invents no
event names. `event-contracts.md` §12 fixes 36 names, and `job.cancelled` is
the only one Phase 8 produces.

### SSE

`GET /books/{id}/events` and `GET /jobs/{id}/events` tail `outbox_message` —
the durable, ordered, tenant-scoped record of every domain fact the system
produces. That is deliberate: §16.19 requires the stream carry "persisted state
changes" and forbids it becoming a second state source, and the outbox already
_is_ that record, so tailing it gives live delivery, `Last-Event-ID`
resumption, and the §12 vocabulary without a parallel in-memory bus that could
disagree with the database.

The trade is poll latency (~1s) rather than push latency. §16.19 states "HTTP
polling is the baseline and is always sufficient"; SSE exists to spare the
_client_ a fast poll. A Redis pub/sub fan-out would cut latency further and is
an additive change — a different transport behind the same endpoint, not a
contract change.

Properties: ownership proven **before** the stream opens (a cross-tenant id is a
`404` with a normal error envelope, not an SSE frame); only the book-scoped
event subset is forwarded; `Last-Event-ID` outside the replay window produces a
`stream.resync` control event telling the client to re-read `.../progress`;
concurrent streams per principal are bounded; a failed poll logs and continues
rather than killing the stream.

### Reconciliation

Project state is never guessed from a stream. Both the poll endpoint and the
stream read persisted state, and a client that misses events re-reads
`.../progress`, which is computed from the database. There is no in-memory
projection to fall out of sync.

`ProcessingJobSweeper` recovers jobs committed to Postgres but never enqueued to
Redis (QA finding F-4), which is the one gap between "job requested" and
"processing started" that the two-phase dispatch creates.

---

## 14. Observability

Every request carries `X-Request-Id` and `X-Trace-Id`, echoed from the client
when supplied. The same value is written to the `ProcessingJob.correlation_id`
of jobs the request creates, to the `outbox_message.correlation_id` of events
those jobs produce, and to `audit_log.correlation_id`. One identifier therefore
traces:

```
HTTP request → job → child jobs → events → audit entry
```

The **worker** link in that chain is missing: `processing_attempt` and `worker`
have no writer in either runtime (QA finding F-26, still OPEN). "Which worker
produced this audio, on which attempt, running which model versions" remains
unanswerable. `GET /jobs/{id}/attempts` and `GET /admin/workers` exist and are
correct; they return empty because nothing registers. An empty fleet view is
itself the operational signal that registration is not running — a missing
endpoint would tell an operator nothing.

Logging redaction (`packages/logging`) already excludes secrets; the audit trail
stores identifiers, counts, and state names only, never book text, signed URLs,
or user-authored free text echoed into indexed fields.

---

## 15. Files

**Added**

```
apps/api/src/jobs/                     job list/get/attempts/cancellation/replay + SSE
apps/api/src/progress/                 book progress read model + book SSE
apps/api/src/events/                   SSE fan-out over the outbox
apps/api/src/users/                    /users/me, preferences, quotas
apps/api/src/platform/                 /capabilities, /model-versions
apps/api/src/admin/                    the §16.22 administrative surface
apps/api/src/common/audit.service.ts   the §14.12 audit trail
apps/api/src/common/quota.service.ts   tenant entitlement enforcement
apps/api/src/common/prisma-error.ts    P2023/P2025 → 4xx instead of 500
apps/api/src/common/guards/platform-admin.guard.ts
apps/api/src/common/guards/quota.guard.ts
apps/api/src/common/interceptors/audit.interceptor.ts
packages/queue/src/cancellation.ts     the shared cancellation flag contract
apps/worker-cpu/src/cancellation-gate.ts
python/workers-common/src/workers_common/cancellation.py
prisma/migrations/0004_phase8_read_model_indexes/
```

**Modified**

```
apps/api/src/books/                    PATCH/DELETE, files, pagination, ETag, include=stages
apps/api/src/app.module.ts             new modules + global audit interceptor
apps/api/src/common/providers.module.ts
apps/api/src/common/filters/all-exceptions.filter.ts   framework + Prisma error mapping
apps/api/src/common/tokens.ts
packages/errors/src/index.ts           METHOD_NOT_ALLOWED category (§9.1)
packages/database/src/client.ts        closed-vocabulary enum re-exports
packages/queue/src/queue-manager.ts    removeQueuedJob
python/workers-common/src/workers_common/queue.py      cancellation check at job start
prisma/schema.prisma                   four read-model indexes
packages/contracts/schemas/            five new request schemas
```
