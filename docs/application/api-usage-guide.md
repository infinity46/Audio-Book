# API Usage Guide — driving the whole workflow from a client

> For frontend and integration developers. The authority is
> `api-specification.md`; this guide shows the **implemented** path through it,
> in the order a client actually walks. Errors are covered separately in
> `error-handling.md`.
>
> Nothing here requires knowing about queues, workers, GPUs, model paths, the
> database, or provider credentials. If you find yourself needing one of those,
> that is a gap in this API, not something to work around.

---

## 0. Conventions in 60 seconds

|                 |                                                                                   |
| --------------- | --------------------------------------------------------------------------------- |
| Base URL        | `/api/v1`                                                                         |
| Casing          | `snake_case` everywhere in JSON                                                   |
| Auth            | `Authorization: Bearer <access_token>`                                            |
| Single resource | `{ "data": { … } }`                                                               |
| Collection      | `{ "data": [ … ], "page": { limit, next_cursor, prev_cursor, has_more, total } }` |
| Async command   | `202` + `{ "data": { "job": {…}, "accepted": {…} } }`                             |
| Errors          | `{ "error": { code, message, details, request_id, trace_id, retryable } }`        |
| Ids             | UUIDv7, time-sortable                                                             |
| Timestamps      | RFC 3339 UTC, e.g. `2026-08-27T15:04:03.221Z`                                     |
| Progress        | floats `0.0`–`1.0`, **not** percentages                                           |

Every response carries `X-Request-Id` and `X-Trace-Id`. Log them.

Send `Idempotency-Key: <uuid>` on every expensive `POST`. Reuse the same key
when retrying the same intent.

---

## 1. The shape of the whole workflow

```
create book ─► upload file ─► ingestion ─► analysis ─► casting ─► director ─► tts ─► assembly ─► download
     201          201/PUT        202          202        200/PUT     202       202      202       200 (signed URL)
                                  └──────────── poll GET /books/{id}/progress, or stream /events ────────────┘
```

Five of those steps are **stage commands** and share one shape:

```
POST /api/v1/books/{bookId}/{stage}   → 202 + job handle
GET  /api/v1/books/{bookId}/{stage}   → that stage's current state
```

`{stage}` ∈ `ingestion | analysis | director | tts | assembly`. There is no
other way to start work, and no RPC verb anywhere in the API.

---

## 2a. Authenticate

```http
POST /api/v1/auth/register
Content-Type: application/json

{ "email": "reader@example.com", "password": "correct-horse-battery-staple" }
```

→ `201 { "data": { "status": "REGISTRATION_PENDING" } }` when enumeration
protection is on (the default) — **this response is identical whether the
email was new or already registered**, by design (§14.11). Do not infer
success or failure from it.

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "reader@example.com", "password": "…", "client_type": "API" }
```

→ `200 { "data": { "status": "AUTHENTICATED", "access_token": "…",
"expires_in": 900, "refresh_token": "…", "token_type": "Bearer" } }` for
`client_type: "API"`. Use `access_token` as `Authorization: Bearer` on every
other request in this guide; refresh before it expires:

```http
POST /api/v1/auth/refresh
Content-Type: application/json

{ "refresh_token": "…" }
```

→ a new `access_token` **and** a new `refresh_token` — the old refresh token
is now spent; store the new one and discard the old. Presenting a spent
refresh token a second time is `401 REFRESH_TOKEN_REUSED` and revokes the
whole session as a precaution — this is not a bug to retry around.

`client_type: "BROWSER"` sets an httpOnly session cookie instead and returns
no tokens in the body; a browser client then calls `/auth/refresh` once
(cookie-authenticated) to obtain a short-lived access token to hold in
memory. `POST /auth/logout` (bearer-authenticated) revokes the current
session; `GET /users/me/sessions` lists every active one, `DELETE
/users/me/sessions/{id}` revokes a specific one (e.g., "sign out on all other
devices").

---

## 2. Bootstrap

```http
GET /api/v1/users/me
GET /api/v1/users/me/quotas
GET /api/v1/capabilities
```

Read `/capabilities` **once at startup** and use it instead of hard-coding
anything: page limits, body and upload size ceilings, signed-URL expiry, the
accepted MIME types, the delivery formats, and the closed `emotion` /
`delivery_mode` vocabularies your pickers render.

`/users/me/quotas` tells you remaining capacity _before_ a user starts
something expensive. It fails open — a `degraded: true` response with `used:
null` means the aggregator is unavailable, not that usage is zero.

---

## 3. Create a project

A **project is a book**. `/api/v1/books/{bookId}` is the workspace everything
hangs off.

```http
POST /api/v1/books
Idempotency-Key: 6f1c…
Content-Type: application/json

{ "title": "The Long Voyage", "author": "A. Writer", "language": "en-GB",
  "description": "…",
  "metadata": { "series": "Voyages", "series_index": 1, "publication_year": 2024 } }
```

→ `201`, `Location: /api/v1/books/{id}`, body is the book resource with a
`links` object pointing at `progress`, `events`, `jobs`, and `files`.

### List, filter, paginate

```http
GET /api/v1/books?limit=25&status=GENERATING,COMPLETED&cursor=<opaque>
```

Cursor pagination only — walk `page.next_cursor` until `page.has_more` is
false. Do not construct or parse a cursor; it is opaque and an invalid one is
`422 INVALID_CURSOR`. Soft-deleted books are hidden unless
`include_deleted=true`.

### Read one, with a pipeline overview

```http
GET /api/v1/books/{id}?include=stages
```

`include=stages` embeds the same per-stage summary `GET .../progress` reports,
so a dashboard renders in one request. `stages` is the only accepted value;
anything else is `422`.

The response carries an `ETag` — keep it for step 3b.

### Update metadata safely

```http
PATCH /api/v1/books/{id}
If-Match: "9f2c…"

{ "title": "The Long Voyage Home" }
```

Patchable: `title`, `author`, `language`, `description`, `metadata`. **Not**
`status` — pipeline state changes because work happened, not because a client
asked, and sending it is `422 unknown_field`.

`language` cannot change once ingestion has produced canonical text (`409
INVALID_STATE_TRANSITION`); create a new book instead.

`If-Match` is optional but recommended wherever two sessions can edit the same
field. Stale → `409 RESOURCE_VERSION_CONFLICT`; re-read, merge, retry.

### Delete

`DELETE /api/v1/books/{id}` → `204`. This is a **soft** delete: the book leaves
`GET /books`, artifacts are retained for the retention window, and deleting
twice is `204` both times. Refused with `409 BOOK_HAS_ACTIVE_JOBS` while jobs
are `QUEUED`/`RUNNING`/`RETRYING` — cancel them first.

### Restore or permanently purge a deleted book

```http
POST /api/v1/books/{id}/restoration
```

→ `200` with the restored book, undoing the soft delete — `TENANT_OWNER`
only (`403` for any other tenant member). `409 INVALID_STATE_TRANSITION` if
the book was not deleted; `410 RESOURCE_PURGED` if it is gone for good (next
paragraph).

```http
POST /api/v1/books/{id}/purge
Idempotency-Key: 8a3f…
Content-Type: application/json

{ "confirm_book_id": "{id}" }
```

→ `202` with a job handle. **Irreversible.** `confirm_book_id` must equal the
path id or `422`; the book must already be soft-deleted with no active jobs.
Purge runs asynchronously and deletes potentially millions of objects — poll
the job, or just retry any read of the book: once purge completes, **every**
endpoint for that `bookId` starts returning `410 RESOURCE_PURGED`, forever.
`TENANT_OWNER` only.

---

## 4. Upload the source

Three calls. The bytes go to object storage, never through this API.

```http
POST /api/v1/books/{bookId}/upload-sessions
Idempotency-Key: …
{ "file_name": "voyage.pdf", "declared_mime_type": "application/pdf",
  "declared_size_bytes": 8123456,
  "declared_content_hash": { "algorithm": "SHA256", "value": "…" },
  "source_kind": "PDF" }
```

→ `201` with `upload_targets[0].url` (a signed `PUT`) and `expires_at`.

```http
PUT <upload_targets[0].url>          ← the file bytes, directly to storage
```

```http
POST /api/v1/books/{bookId}/upload-sessions/{sessionId}/completion
Idempotency-Key: …
{ "observed_size_bytes": 8123456 }
```

The server re-downloads, verifies size and SHA-256, sniffs the real format
against the declared one, checks for a duplicate in your tenant, creates the
`BookFile`, and enqueues `parse_book`. Response is `202` with a job handle.

Mismatches are `409 UPLOAD_INCOMPLETE` / `409 CHECKSUM_MISMATCH` /
`415 UNSUPPORTED_FILE_FORMAT`. A duplicate is `409 DUPLICATE_CONTENT_HASH`
unless you pass `allow_duplicate: true`.

`GET /api/v1/books/{bookId}/files` lists admitted source files.

---

## 5. Drive the pipeline

Each stage command returns `202` immediately. **Never wait on one.**

```http
POST /api/v1/books/{id}/ingestion   { "book_file_id": "…" }
POST /api/v1/books/{id}/analysis    { "scope": "BOOK" }
POST /api/v1/books/{id}/director    { "scope": "BOOK" }
POST /api/v1/books/{id}/tts         { "scope": "BOOK" }
POST /api/v1/books/{id}/assembly    { "scope": "AUDIOBOOK", "delivery_formats": ["M4B"] }
```

Response:

```json
{
  "data": {
    "job": {
      "id": "01J9…",
      "object": "job",
      "type": "generate_tts_chunk",
      "status": "QUEUED",
      "book_id": "01J9…",
      "links": { "self": "/api/v1/jobs/01J9…" }
    },
    "accepted": {
      "scope": "BOOK",
      "planned_unit_count": 8420,
      "skipped_unit_count": 1188,
      "skip_reason": "EXISTING_VALID_OUTPUT_FOR_LINEAGE"
    }
  }
}
```

`accepted` describes what was **admitted**, not what was produced.
`planned_unit_count` and `skipped_unit_count` are the honest basis for a
progress bar, and `status` is only ever `CREATED`, `QUEUED`, or `BLOCKED` — a
`202` never implies the work happened.

### Scoped invocation is how you regenerate

The same endpoint, narrowed:

```json
{ "scope": "CHAPTERS", "chapter_ids": ["…"] }
{ "scope": "CHUNKS",   "chunk_ids": ["…"] }
{ "scope": "FILTER",   "filter": { "audio_chunk_status": ["FAILED", "INVALID"] } }
```

Add `"force": true` to redo work that already has valid output. Regeneration
always writes a **new** version and supersedes the old one; nothing is
overwritten, and only dependent artifacts are invalidated.

### Preconditions are enforced up front

`POST .../tts` refuses with `409` when the Audio Script is not `VALIDATED`,
when any chunk has no resolvable voice (`CASTING_INCOMPLETE`, with up to 20
offending ids in `details[]`), or when a bound voice version is not `APPROVED`
or `LOCKED`. Fix the cause, then re-invoke.

---

## 6. Casting (before TTS)

```http
GET /api/v1/books/{id}/casting                                    ← readiness
GET /api/v1/voice-profiles                                        ← tenant library
POST /api/v1/voice-profiles                                       ← create
POST /api/v1/voice-profiles/{id}/versions                          ← new version
POST /api/v1/voice-profiles/{id}/versions/{v}/previews             ← 202, hear it first
POST /api/v1/voice-profiles/{id}/versions/{v}/approval             ← approve
PUT  /api/v1/books/{id}/characters/{characterId}/voice             ← assign
POST /api/v1/books/{id}/casting/narrator-fallback                  ← accept fallback
```

Assignments reference a **`VoiceProfileVersion`**, never a profile and never a
transient provider embedding — that is what makes a rendered chunk traceable to
the exact voice that produced it.

Changing a character's voice after generation does **not** rewrite existing
audio. It affects the next generation; the previous version stays reachable and
byte-identical.

---

## 7. Watch progress

Two mechanisms, one source of truth.

### Poll

```http
GET /api/v1/books/{id}/progress
```

```json
{
  "data": {
    "object": "book_progress",
    "book_status": "GENERATING",
    "overall_progress": 0.58,
    "degraded": false,
    "stages": [
      {
        "stage": "ingestion",
        "status": "COMPLETED",
        "progress": 1.0,
        "completed_units": 412,
        "total_units": 412,
        "failed_units": 3,
        "flagged_units": 3
      },
      {
        "stage": "tts",
        "status": "RUNNING",
        "progress": 0.61,
        "completed_units": 5180,
        "total_units": 8420,
        "failed_units": 14,
        "flagged_units": 6
      },
      {
        "stage": "assembly",
        "status": "NOT_STARTED",
        "progress": null,
        "completed_units": 0,
        "total_units": null,
        "failed_units": 0,
        "flagged_units": 0
      }
    ],
    "active_job_ids": ["01J9…"],
    "needs_review_count": 43,
    "estimate": {
      "remaining_ms": 9420000,
      "confidence": "LOW",
      "basis": "COMPLETED_UNIT_RATE",
      "computed_at": "…"
    },
    "updated_at": "…"
  }
}
```

**Read these three rules into your UI, or it will lie to users:**

1. `null` ≠ `0`. `total_units: null` means the denominator is not knowable yet
   (no script exists, so nobody knows how many chunks TTS will render). Render
   "preparing…", not "0%".
2. `estimate.confidence: "NONE"` means `remaining_ms` is `null`. Do not
   substitute your own estimate — the server declines to guess for a reason.
3. `progress` is `0.0`–`1.0`. Multiply by 100 yourself.

Stage `status` comes from the §20.5 vocabulary:
`NOT_STARTED | QUEUED | RUNNING | VALIDATING | BLOCKED | PARTIAL | NEEDS_REVIEW | COMPLETED | FAILED | CANCELLED`
(not every value applies to every stage). Treat an unrecognized value as
unknown rather than crashing.

Poll no faster than the `RateLimit-*` headers on the `read` bucket advise.

### Stream

```http
GET /api/v1/books/{id}/events
Accept: text/event-stream
Last-Event-ID: 01J9ZEVT…
```

```
: keep-alive

id: 01J9ZEVT…0043
event: tts.chunk_completed
data: {"schema_version":"events.v1","event_type":"tts.chunk_completed","occurred_at":"…","book_id":"…","correlation_id":"…","payload":{…}}
```

- The credential goes in the `Authorization` header or the session cookie —
  **never** a query parameter, because URLs are logged.
- Reconnect with `Last-Event-ID` to resume. If the server replies with an
  `event: stream.resync` frame, your id is outside the replay window: re-read
  `GET .../progress` and continue.
- Events carry identifiers and small facts only — never text, audio, or signed
  URLs. Follow up with a read if you need content.
- The stream is a **notification channel, not a source of truth**. Polling
  alone is always sufficient; SSE just spares you a fast poll.
- Concurrent streams per principal are bounded; exceeding is `429`.
- `GET /api/v1/jobs/{jobId}/events` is the same thing scoped to one job.

---

## 8. Jobs

```http
GET  /api/v1/jobs?book_id=…&status=RUNNING,RETRYING&type=generate_tts_chunk&sort=created_at:desc
GET  /api/v1/jobs/{jobId}
GET  /api/v1/jobs/{jobId}/attempts
POST /api/v1/jobs/{jobId}/cancellation
```

Filters: `book_id`, `type` (multi, comma-separated), `status` (multi),
`related_resource_id`, `created_after`, `created_before`. Sort is an allowlist —
`created_at` or `completed_at`, `:asc` or `:desc`. Anything else is `422`, not
a silently-ignored parameter.

Job statuses are exactly nine:
`CREATED | QUEUED | RUNNING | RETRYING | BLOCKED | SUCCEEDED | FAILED | CANCELLED | DEAD_LETTERED`.
Terminal: the last four.

`result` is `null` in every non-terminal state — the API never predicts an
outcome.

Most clients should watch the **coordinator** job returned by the `202` and the
aggregate `progress`, not individual worker jobs. Per-job reads are for
diagnosis.

`/attempts` is the audit trail behind "why does this chapter sound different?".
It is currently empty in every deployment: attempt records have no writer yet
(see the Phase 8 report, finding F-26).

---

## 9. Cancel

```http
POST /api/v1/jobs/{jobId}/cancellation
{ "reason": "User cancelled from the studio view." }
```

Always `200`, always idempotent, never `409`. Read the response, do not assume:

```json
{
  "data": {
    "status": "RUNNING",
    "cancellation": {
      "requested": true,
      "requested_at": "…",
      "requested_by": "…",
      "effective": false
    }
  }
}
```

`effective: false` on a `RUNNING` job means **the work has not stopped yet**.
The worker observes the request at its next boundary and exits cleanly; poll
until `status` becomes `CANCELLED`. A UI that shows "cancelled" the instant the
call returns is lying about a GPU that is still running.

Cancelling a coordinator cascades to its children. Cancelling a job that is
already `SUCCEEDED` is a no-op — a completed job cannot be un-completed.

**Completed work is kept.** Cancelling at chunk 8 000 of 10 000 and resuming
later renders 2 000, not 10 000.

---

## 10. Review

There is no `/review-items` endpoint — the architecture reserves that concept
without specifying it (`api-specification.md` §15.18, OQ-3). Review information
reaches you through:

```http
GET /api/v1/books/{id}/audio-script-chunks?has_review_flags=true
GET /api/v1/books/{id}/progress          → stages[].flagged_units, needs_review_count
GET /api/v1/books/{id}                   → needs_review, status = NEEDS_REVIEW
GET /api/v1/books/{id}/audio-chunks?status=INVALID
```

`review_flags[]` on a chunk is a closed vocabulary: `DIRECTOR_FALLBACK`,
`UNKNOWN_SPEAKER`, `LOW_CONFIDENCE`, `CHARACTER_METADATA_CHANGED`,
`PRONUNCIATION_LEXICON_CHANGED`, `CAPABILITY_GAP`, `TEXT_HASH_MISMATCH`.

To act on a flag: `PATCH .../audio-script-chunks/{id}` to adjust approved
performance metadata (permitted while `DRAFT`/`VALIDATED`), then re-invoke the
stage with `scope: CHUNKS`. Canonical book text is never editable through any
endpoint.

The gate is **advisory** today: nothing blocks generation on unreviewed flags.

---

## 11. Get the audio

```http
GET  /api/v1/books/{id}/audiobook              ← the current audiobook project
GET  /api/v1/books/{id}/audiobooks             ← every version
GET  /api/v1/books/{id}/chapter-audio          ← per-chapter
POST /api/v1/books/{id}/audiobooks/{id}/access-urls
```

Note the two-step: `GET .../audiobook` returns an **`audiobook_project`** whose
lifecycle field is `generation_status`
(`NOT_STARTED | BLOCKED | ASSEMBLING | COMPLETED | FAILED | STALE`). Follow its
`current_audiobook_id` to the **`audiobook`** resource, whose own `status`
reaches `READY`. These are different objects with different vocabularies;
reading `status` on the project finds nothing.

To download:

```http
POST /api/v1/books/{id}/audiobooks/{audiobookId}/access-urls
{ "disposition": "ATTACHMENT", "expires_in_seconds": 900 }
```

→ `200` with `{ url, method, expires_at, content_type, size_bytes, content_hash }`.

Fetch the bytes from that URL directly. Range requests and seeking are handled
by object storage, so an audio player can stream from the signed URL without
this API in the path. Mint a fresh URL when one expires — they are short-lived
by policy and deliberately not cacheable.

The same `access-urls` sub-resource exists on chapter audio, audio chunks,
canonical text, and voice previews.

---

## 12. Versions and immutability

Artifacts are versioned and never rewritten:

```
AudioChunk.generation_version   ChapterAudio.version   Audiobook.version
```

with an `is_current` flag. Consequences for a client:

- A change of voice, script, or configuration produces a **new** version. The
  previous one remains downloadable and byte-identical.
- `GET .../audiobook` gives you the current pointer; `GET .../audiobooks` gives
  you the history. Show the version, not just "latest" — a user comparing two
  renders needs to know which is which.
- Immutable resources expose no mutation endpoint at all. Attempting one is
  `405` when the method is never supported, `409` when the resource's current
  state is what forbids it.

---

## 13. Everything a dashboard needs, by screen

| Screen            | Calls                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Library           | `GET /books` (paginated, filterable), `GET /users/me/quotas`                     |
| Create + upload   | `POST /books`, `POST .../upload-sessions`, `PUT <signed>`, `POST .../completion` |
| Project overview  | `GET /books/{id}?include=stages`, `GET /books/{id}/progress`                     |
| Live progress     | `GET /books/{id}/events` (SSE), falling back to polling progress                 |
| Cast              | `GET .../characters`, `GET /voice-profiles`, `PUT .../characters/{id}/voice`     |
| Review queue      | `GET .../audio-script-chunks?has_review_flags=true`                              |
| Job inspector     | `GET /jobs?book_id=…`, `GET /jobs/{id}`, `POST /jobs/{id}/cancellation`          |
| Player + download | `GET .../audiobook` → `GET .../audiobooks/{id}` → `POST .../access-urls`         |
| Settings          | `GET/PATCH /users/me`, `GET /capabilities`                                       |

---

## 14. Not available

Called out so you do not build against them:

- `/api/v1/auth/mfa` enrollment — **exchange** is implemented (§2a), but
  there is no way to enroll a factor. `mfaEnrolled` is never `true` in this
  deployment, so no login ever produces an `mfa_token` for it. Do not build
  an enrollment UI against it.
- `/review-items` — reserved, not specified (§15.18).
- Multipart upload — the upload session mints a single `PUT` target.
- WebSockets — SSE is the `v1` contract for one-way progress.
- `POST /jobs/{id}/retry` — by design; use a scoped stage command.
- Tenant-level closure/purge — only book-level purge (§3) exists; there is no
  "delete my whole workspace" endpoint.
