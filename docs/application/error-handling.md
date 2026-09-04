# Error Handling — what a client sees when something goes wrong

> Companion to `application-architecture.md`. The authority is
> `api-specification.md` §8 (envelope), §9 (status codes), and §21 (code
> registry); this document describes what is **implemented** and how to act on
> it.

---

## 1. The envelope

Every failure, from every endpoint, returns exactly this shape:

```json
{
  "error": {
    "code": "AUDIO_SCRIPT_NOT_VALIDATED",
    "message": "Audio Script is DRAFT, not VALIDATED.",
    "details": [{ "field": "scope", "issue": "invalid_enum" }],
    "request_id": "01J9ZREQ0000000000000001",
    "trace_id": "01J9ZTRC0000000000000001",
    "retryable": false,
    "documentation_url": null
  }
}
```

| Field        | Meaning                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `code`       | `SCREAMING_SNAKE_CASE`, stable, one meaning, one HTTP status. **Branch on this, never on `message`.** |
| `message`    | Human-readable, may change, may be localized by `Accept-Language`. Never contains internals.          |
| `details[]`  | Field-level detail on validation failures: `{ field?, issue }`                                        |
| `request_id` | Echoes `X-Request-Id`. Quote this in a bug report.                                                    |
| `trace_id`   | Echoes `X-Trace-Id`.                                                                                  |
| `retryable`  | Whether retrying the _identical_ request could succeed.                                               |

`request_id` and `trace_id` are also response headers on **every** response,
success included, so a client can log them without parsing a body.

### What an error never contains

Stack traces, exception class names, file paths, SQL, queue/Redis keys, storage
keys, bucket names, hostnames, worker or GPU identifiers, signed URLs, provider
credentials, or book text (§8.2). Anything unrecognized collapses to a generic
`INTERNAL_ERROR` rather than leaking its own message.

---

## 2. Status codes and what to do about each

| Status | Meaning                                                                    | Client action                                            |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `400`  | Malformed syntax — unparseable JSON, missing required header               | Fix the request. Never retry unchanged.                  |
| `401`  | Missing, malformed, expired, or revoked credential                         | Re-authenticate, then retry once.                        |
| `403`  | Valid credential, insufficient role — **within your tenant**               | Do not retry. Surface a permissions message.             |
| `404`  | Unknown, cross-tenant, or soft-deleted resource                            | Do not retry. See §3.                                    |
| `405`  | The resource never supports this method                                    | A client bug. Do not retry.                              |
| `409`  | State conflict, unmet prerequisite, idempotency conflict, version conflict | See §4 — the action differs per code.                    |
| `410`  | Purged resource, known to have existed                                     | Do not retry. Remove from the UI.                        |
| `413`  | Body or declared upload above the limit                                    | Reduce the payload. Read `/capabilities` for the limits. |
| `415`  | Non-JSON `Content-Type` on a JSON endpoint                                 | A client bug.                                            |
| `422`  | Semantic/field validation failure on a well-formed body                    | Read `details[]`, fix the fields.                        |
| `429`  | Rate limit **or** quota                                                    | See §5 — these are different.                            |
| `500`  | Unhandled server fault                                                     | Retry with backoff; report `request_id`.                 |
| `502`  | An upstream internal service returned an unusable response                 | Retry with backoff.                                      |
| `503`  | A required dependency is unavailable, or the service is draining           | Honour `Retry-After`.                                    |

`501`, `307`, and `308` are never used by `/api/v1/**`.

### `404` vs `403` — a deliberate asymmetry

A resource belonging to **another tenant** is always `404`, never `403`. A
`403` would confirm that the resource exists somewhere, which is an
information leak across a tenant boundary (§6.4). Within your own tenant, a
permission failure is `403`, because existence is already known to you.

So a `404` means one of: the id does not exist, it belongs to someone else, or
it was soft-deleted. The API will not tell you which, and that is intentional.

### `405` vs `409`

- `405` — the resource _never_ supports the method. `PATCH` on an `AudioChunk`
  is always `405`: audio chunks are immutable by architecture.
- `409` — the resource supports the method, but its **current state** forbids
  it. `PATCH` on a frozen script chunk is `409`, because the same call on a
  `DRAFT` chunk succeeds.

---

## 3. The safe error categories

Every code maps to exactly one category and one status. These are the ones the
application layer produces.

### Input

| Code                      | Status | Retryable | Action                                    |
| ------------------------- | ------ | --------- | ----------------------------------------- |
| `VALIDATION_FAILED`       | 422    | no        | Read `details[]`.                         |
| `INVALID_IDENTIFIER`      | 422    | no        | An id in the path or query is not a UUID. |
| `INVALID_CURSOR`          | 422    | no        | Restart pagination from the first page.   |
| `MALFORMED_REQUEST`       | 400    | no        | Unparseable body.                         |
| `MISSING_IDEMPOTENCY_KEY` | 400    | no        | Add the header; see §6.                   |
| `UNSUPPORTED_FILE_FORMAT` | 415    | no        | Convert the file.                         |
| `FILE_TOO_LARGE`          | 422    | no        | Check `/capabilities` for the ceiling.    |

`details[].issue` is a closed vocabulary: `required`, `unknown_field`,
`invalid_type`, `invalid_enum`, `invalid_format`, `too_long`, `too_short`,
`out_of_range`, `duplicate`.

**Unknown fields are rejected, not ignored.** Sending `{"reason": "x",
"force_kill": true}` is `422` with `issue: "unknown_field"` — the API will not
silently drop something you asked for (§2.9 strict mode).

### Authentication and authorization

| Code                          | Status | Action                                                                                                               |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`             | 401    | Refresh the credential.                                                                                              |
| `FORBIDDEN`                   | 403    | Insufficient role. Do not retry.                                                                                     |
| `ADMIN_CONTENT_ACCESS_DENIED` | 403    | A `PLATFORM_ADMIN` tried to reach tenant content or mint an artifact URL. Prohibited by §6.6 through _any_ endpoint. |

### Resource and state

| Code                                                      | Status | Action                                             |
| --------------------------------------------------------- | ------ | -------------------------------------------------- |
| `RESOURCE_NOT_FOUND` / `BOOK_NOT_FOUND` / `JOB_NOT_FOUND` | 404    | See §3 above.                                      |
| `RESOURCE_GONE`                                           | 410    | Purged. Drop it.                                   |
| `RESOURCE_VERSION_CONFLICT`                               | 409    | Re-read, merge, retry with the new `ETag`. See §4. |
| `INVALID_STATE_TRANSITION`                                | 409    | The message says what state blocks it.             |
| `BOOK_HAS_ACTIVE_JOBS`                                    | 409    | Cancel the jobs first (§16.18), then retry.        |

### Pipeline

| Code                                | Status | Meaning                                                                               |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `AUDIO_SCRIPT_NOT_VALIDATED`        | 409    | Run the Director stage first.                                                         |
| `CASTING_INCOMPLETE`                | 409    | Some chunks have no resolvable voice. `details[]` names up to 20.                     |
| `VOICE_PROFILE_NOT_APPROVED`        | 409    | The bound voice version is not `APPROVED` or `LOCKED`.                                |
| `CHAPTER_MANIFEST_INCOMPLETE`       | 409    | Assembly needs every chunk `VALIDATED`, or `allow_partial_preview: true`.             |
| `DIRECTOR_VERSION_MIXING_FORBIDDEN` | 409    | Acknowledge explicitly or keep the existing version.                                  |
| `ARTIFACT_NOT_READY`                | 409    | The bytes do not exist yet. Poll progress.                                            |
| `JOB_NOT_REPLAYABLE`                | 409    | Only `DEAD_LETTERED`/`FAILED` jobs with a recorded dispatch envelope can be replayed. |

### Infrastructure

| Code                     | Status | Retryable      |
| ------------------------ | ------ | -------------- |
| `DEPENDENCY_UNAVAILABLE` | 502    | yes            |
| `QUEUE_UNAVAILABLE`      | 503    | yes            |
| `STORAGE_UNAVAILABLE`    | 503    | yes            |
| `INTERNAL_ERROR`         | 500    | no (report it) |

---

## 4. Conflicts you can actually resolve

### `409 RESOURCE_VERSION_CONFLICT` — optimistic concurrency

`GET` on a mutable resource returns an `ETag`. `PATCH` **may** carry
`If-Match`. When present and stale, the write is refused rather than silently
clobbering a newer version.

```
GET   /api/v1/books/{id}                    → 200, ETag: "9f2c…"
PATCH /api/v1/books/{id}  If-Match: "9f2c…" → 200, ETag: "a13e…"
PATCH /api/v1/books/{id}  If-Match: "9f2c…" → 409 RESOURCE_VERSION_CONFLICT
```

Recovery: re-`GET`, merge your change onto the newer state, retry with the new
`ETag`. Omitting `If-Match` gives last-write-wins over **only the fields in
your patch body** — safe when a form owns disjoint fields, unsafe when two
sessions edit the same one.

`If-Match: *` always matches.

### `409 IDEMPOTENCY_KEY_CONFLICT`

The same `Idempotency-Key` was reused with a **different** body. Either you
meant to retry (send the identical body) or you meant a new operation (mint a
new key). See §6.

### `409 REQUEST_IN_PROGRESS`

An identical request with this key is still running. Wait and retry — the
second call will return the first one's stored response.

---

## 5. `429` — two different situations

Both are `429`, and conflating them wastes requests:

| Code             | Meaning                         | `retryable` | Action                                                                                                      |
| ---------------- | ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `RATE_LIMITED`   | Too many requests in the window | `true`      | Honour `Retry-After`, then retry.                                                                           |
| `QUOTA_EXCEEDED` | Tenant entitlement exhausted    | `false`     | Retrying will not help. Wait for work to finish, or for the period to roll over, or ask for a higher limit. |

Rate-limited responses carry `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`, and `Retry-After`. The buckets are `read`, `write`,
`upload`, `expensive` (any stage command), and `access_url`; limits apply per
user, per tenant, and per IP.

**Rate limiting is request admission only.** The API never rejects work because
the GPU fleet is busy — that would be backpressure disguised as a client error,
and the contract forbids it. A busy fleet shows up as a job that stays `QUEUED`.

---

## 6. Idempotency

`Idempotency-Key` is **required** on expensive, state-changing `POST`s: book
creation, upload finalization, every stage command, voice-version and preview
creation, and admin replay. Use a fresh UUIDv4 per logical operation.

- Same key + same body → the **original** response is replayed, including its
  status code. No second book, no second pipeline.
- Same key + different body → `409 IDEMPOTENCY_KEY_CONFLICT`.
- Same key while the first is running → `409 REQUEST_IN_PROGRESS`.
- Keys are scoped to `(tenant, principal, method, path template)` and expire
  after 24 hours.

This is what makes a client retry after a network timeout safe: you do not know
whether the first request landed, and with the same key it does not matter.

Cancellation deliberately needs **no** key — it is idempotent by construction.

---

## 7. Async failures do not arrive as HTTP errors

A `202` means the work was _accepted_, nothing more. Failures after that point
appear in state, not in a status code:

```
POST /books/{id}/tts  → 202 { job: { id, status: "QUEUED" } }
        ↓
GET /jobs/{jobId}     → status: "FAILED",
                        error: { code, class, message, retryable, terminal, attempt_number }
        ↓
GET /books/{id}/progress
        → stages[].status = "FAILED", failed_units = 14
```

The job's `error.retryable` and `error.terminal` tell you whether the system
will try again on its own. A `RETRYING` job carries `next_attempt_at`. A job
that exhausted its budget is `DEAD_LETTERED` — visible to the user, replayable
only by an operator.

A user-visible "try again" is a **scoped stage command**, not a retry endpoint:
`POST /books/{id}/tts` with `scope: CHUNKS` and the failed chunk ids, which
creates fresh jobs with full lineage. There is deliberately no
`POST /jobs/{id}/retry`.

---

## 8. Degraded is not an error

Some reads are allowed to succeed while incomplete. Those return `200` with:

```json
{ "data": { "degraded": true, "degraded_reasons": ["WORKER_CAPABILITY_REGISTRY_UNAVAILABLE"], … } }
```

Degradation is **never** signalled by a `5xx` and never by silently omitting
data. Endpoints where it can occur always carry `degraded`, `false` when
complete: `/capabilities`, `/users/me/quotas`, story-bible reads, progress
reads.

Today `/capabilities` reports `degraded: true` with
`WORKER_CAPABILITY_REGISTRY_UNAVAILABLE` and `available: null` per provider,
because no worker registers itself (QA finding F-26). That is the honest answer:
`available: true` would be fabricated.

Related but distinct: `null` in a normal response means "known to be absent",
and a contractual field is never omitted. In progress, `total_units: null`
means _the denominator is not yet knowable_ — it does not mean zero.

---

## 9. Client checklist

1. Branch on `error.code`, never on `error.message`.
2. Log `request_id` and `trace_id` from the headers on every request.
3. Send `Idempotency-Key` on every expensive `POST`, and reuse it on retry.
4. Retry only when `retryable` is `true`, with exponential backoff, honouring
   `Retry-After`.
5. Treat an unknown `error.code` as its HTTP status class — new codes may be
   added within `v1`.
6. Do not treat `404` as "deleted" — it may be a permission boundary.
7. Do not poll faster than the `read` bucket's `RateLimit-*` headers advise;
   use the SSE stream if you need low latency.
8. Read `/capabilities` for limits instead of hard-coding them.
