# Phase 8 Report — Application Layer

**Date:** 2026-09-02
**Scope:** the user-facing application layer above the validated audiobook
engine. Phases 1–7 are not re-tested here except where Phase 8 touched them.

Status vocabulary, applied strictly:

- **PASS** — measured, with the evidence named.
- **FAIL** — measured, and it does not hold.
- **UNKNOWN** — _not measured_. Never a synonym for "probably fine".
- **NOT TESTED** — deliberately out of scope, with the reason given.

Environment: macOS, no GPU, no container runtime. Postgres, Redis, and MinIO on
localhost. **This machine's Postgres has a broken `vector` extension** —
registered in `pg_extension` but its shared library missing from `$libdir` — so
any statement whose plan touches a vector column fails with `58P01`. Confirmed
pre-existing by stashing every Phase 8 change and re-running. It is the same
class as QA finding F-8 and blocks two pre-existing tests; nothing in Phase 8
reads or writes a vector column.

---

## 1. What Phase 8 built

The engine was complete; the layer a user talks to was not. Missing from
`api-specification.md`'s public resource tree before this phase:

| Surface                                | Spec         | Status before         | Status now                 |
| -------------------------------------- | ------------ | --------------------- | -------------------------- |
| Jobs, attempts, cancellation           | §16.18       | absent                | implemented                |
| Book progress read model               | §16.19       | absent                | implemented                |
| SSE event streams                      | §16.19       | absent                | implemented                |
| `/users/me`, preferences, quotas       | §16.2        | absent                | implemented                |
| `/capabilities`, `/model-versions`     | §16.21       | absent                | implemented                |
| Administrative surface                 | §16.22       | absent                | implemented                |
| `PATCH`/`DELETE /books/{id}`, files    | §16.5, §16.6 | absent                | implemented                |
| Book list pagination and filters       | §16.4, §10   | flat `take: 50`       | keyset pagination          |
| Optimistic concurrency (ETag/If-Match) | §2.8         | absent                | implemented                |
| Audit trail                            | §14.12       | table only, no writer | implemented                |
| Quota enforcement                      | §14.3        | absent                | implemented                |
| Cooperative cancellation, worker side  | §29          | absent                | implemented (job boundary) |

---

## 2. The "Project" question

**Resolved as a naming difference, not a schema gap.**

The brief asks for a user-facing `Project`. `api-specification.md` §4.1 defines
the public resource tree with **`Book`** as that workspace, and closes it with a
binding rule: _"No entity is invented."_ The `audiobook_project` that appears in
§20.10 is a **derived read model** — `database-schema.md` §4325 lists it as
`derived`, and §2206 explains why it is not stored.

Creating a `Project` row above `Book` would have introduced a second workspace
identity with no owner service, duplicated `Book`'s sixteen-state lifecycle, and
changed the meaning of every `book_id` foreign key in the schema. **Decision:
`Project` ≡ `Book`.** No new entity, no new table, no new vocabulary.

Reported per §5 of the brief rather than invented around.

---

## 3. Scorecard

| #   | Area                           | What was checked                                                  | Status                                                               | Evidence                                                                                                                                          |
| --- | ------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Project lifecycle              | `Book.status` is the lifecycle; `status` is not patchable         | **PASS**                                                             | `application-layer.e2e.test.ts` "refuses to patch pipeline status"                                                                                |
| 2   | Generation start               | Stage commands validate preconditions before admission            | **PASS** (pre-existing)                                              | `tts.service.test.ts`, `director.service.test.ts`                                                                                                 |
| 3   | Async semantics                | Every stage command returns `202` + job handle, never waits       | **PASS** (pre-existing)                                              | `full-pipeline.e2e.test.ts`                                                                                                                       |
| 4   | Progress — measured            | Numbers come from counted rows, not from job existence            | **PASS**                                                             | `progress.service.test.ts` "does not report progress just because a job succeeded"                                                                |
| 5   | Progress — unknown             | Unknown denominator is `null`, never `0`                          | **PASS**                                                             | same, + e2e "reports a book with no work as UNKNOWN, not 0%"                                                                                      |
| 6   | Progress — monotonic           | TTS measured against script chunks, so progress cannot fall       | **PASS**                                                             | `progress.service.test.ts` "progress cannot decrease"                                                                                             |
| 7   | Progress — ETA honesty         | `confidence: NONE` + `remaining_ms: null` without a measured rate | **PASS**                                                             | `progress.service.test.ts` ETA block                                                                                                              |
| 8   | Progress — bounded cost        | Fixed query count and bounded response regardless of book size    | **PASS** (unit) / **UNKNOWN** (at scale)                             | `progress.service.test.ts` "fixed number of queries"; not run against 10 000 real segments                                                        |
| 9   | Stage projection               | §20.5 vocabulary, never contradicting entity state                | **PASS**                                                             | `progress.service.test.ts` "DRAFT script … reports VALIDATING"                                                                                    |
| 10  | Job vocabulary                 | Exactly the nine `ProcessingJob.status` values, verbatim          | **PASS**                                                             | `jobs.service.test.ts`                                                                                                                            |
| 11  | Job result honesty             | `result` is `null` in every non-terminal state                    | **PASS**                                                             | `jobs.service.test.ts`                                                                                                                            |
| 12  | Cancellation — immediate       | `CREATED`/`QUEUED`/`BLOCKED`/`RETRYING` → `CANCELLED`, effective  | **PASS**                                                             | `jobs.service.test.ts` + e2e                                                                                                                      |
| 13  | Cancellation — running         | `RUNNING` reports `effective: false`; does not claim work stopped | **PASS**                                                             | same                                                                                                                                              |
| 14  | Cancellation — terminal        | Terminal job is `200` no-op, never `409`, never revived           | **PASS**                                                             | same, all four terminal states                                                                                                                    |
| 15  | Cancellation — idempotent      | Repeated calls preserve the original `requested_at`               | **PASS**                                                             | e2e "is idempotent across repeated calls"                                                                                                         |
| 16  | Cancellation — cascade         | Coordinator cancels queued children, requests running ones        | **PASS**                                                             | `jobs.service.test.ts` + e2e                                                                                                                      |
| 17  | Cancellation — retention       | Completed children keep `SUCCEEDED`                               | **PASS**                                                             | `jobs.service.test.ts`                                                                                                                            |
| 18  | Cancellation — durability      | Redis failure still commits `cancellation_requested`              | **PASS**                                                             | `jobs.service.test.ts` "still commits … when Redis is unavailable"                                                                                |
| 19  | Cancellation — worker side     | Worker halts at job boundary and marks the job `CANCELLED`        | **PASS** (code + unit) / **UNKNOWN** (end-to-end with a live worker) | `cancellation-gate.ts`, `workers_common/cancellation.py`; not exercised against a running worker mid-job                                          |
| 20  | Retry                          | No public retry endpoint; scoped stage command + admin replay     | **PASS**                                                             | `jobs.service.test.ts` replay block                                                                                                               |
| 21  | Replay immutability            | Replay creates a new job; original untouched                      | **PASS**                                                             | `jobs.service.test.ts` "leaves the original untouched"                                                                                            |
| 22  | Idempotency                    | Same key + same body replays the original response                | **PASS**                                                             | e2e idempotency block                                                                                                                             |
| 23  | Idempotency conflict           | Same key + different body is `409`                                | **PASS**                                                             | same                                                                                                                                              |
| 24  | Optimistic concurrency         | ETag round-trips; stale `If-Match` is `409`                       | **PASS**                                                             | e2e + `users.service.test.ts`                                                                                                                     |
| 25  | Authentication                 | Every protected route rejects an unauthenticated request          | **PASS**                                                             | e2e, 6 routes + forged token                                                                                                                      |
| 26  | Authorization — IDOR           | Foreign book/job/progress/files are `404`, and unmodified         | **PASS**                                                             | e2e tenant-isolation block                                                                                                                        |
| 27  | Tenant isolation               | Cross-tenant list returns `[]`, not another tenant's rows         | **PASS**                                                             | e2e                                                                                                                                               |
| 28  | Privilege escalation           | Tenant user refused on all six admin routes                       | **PASS**                                                             | e2e + `platform-admin.guard.test.ts`                                                                                                              |
| 29  | Admin content boundary         | `PLATFORM_ADMIN` refused on tenant content (§6.6)                 | **PASS**                                                             | e2e; guard pair proven disjoint in unit test                                                                                                      |
| 30  | Admin data minimisation        | Tenant detail returns counts, never book titles                   | **PASS**                                                             | e2e                                                                                                                                               |
| 31  | Admin auditing                 | Every admin read writes `ADMIN_CROSS_TENANT_READ`                 | **PASS**                                                             | e2e                                                                                                                                               |
| 32  | Audit trail                    | User actions recorded against the acting user                     | **PASS**                                                             | e2e (book creation, job cancellation)                                                                                                             |
| 33  | Audit safety                   | User-authored reason not echoed into indexed metadata             | **PASS**                                                             | e2e "records an audit row naming the actor"                                                                                                       |
| 34  | Quotas — closed                | Enforcement refuses past the limit, non-retryable                 | **PASS**                                                             | `quota.service.test.ts`                                                                                                                           |
| 35  | Quotas — open                  | Quota read degrades to `200` + `degraded: true`                   | **PASS**                                                             | `users.service.test.ts`                                                                                                                           |
| 36  | Quotas — no invention          | Tenant with no quota row is unlimited, not zero                   | **PASS**                                                             | `quota.service.test.ts`                                                                                                                           |
| 37  | Rate limiting                  | Per-bucket throttling on expensive endpoints                      | **PASS** (pre-existing)                                              | `rate-limit.integration.test.ts`                                                                                                                  |
| 38  | Rate limit numbers             | Are the configured limits right for real traffic?                 | **UNKNOWN**                                                          | Defaults are unmeasured starting points, unchanged from Phase 7                                                                                   |
| 39  | Pagination                     | Every large collection paginates; cursor walk is stable           | **PASS**                                                             | e2e "walks a cursor without repeating or skipping"                                                                                                |
| 40  | Filtering safety               | Unknown enum values are `422`, not a 500 or a scan                | **PASS**                                                             | e2e + `jobs.service.test.ts`                                                                                                                      |
| 41  | Sorting safety                 | Sort restricted to an indexed allowlist                           | **PASS**                                                             | `jobs.service.test.ts`                                                                                                                            |
| 42  | Soft delete                    | `204`, hidden from list, row retained, idempotent                 | **PASS**                                                             | e2e book-lifecycle block                                                                                                                          |
| 43  | Delete safety                  | Refused while jobs are live (`BOOK_HAS_ACTIVE_JOBS`)              | **PASS**                                                             | e2e                                                                                                                                               |
| 44  | Error envelope                 | Every failure carries the §8.1 shape                              | **PASS**                                                             | e2e                                                                                                                                               |
| 45  | Error safety                   | No stack traces, SQL, paths, or internals leak                    | **PASS**                                                             | e2e "never leaks internals"                                                                                                                       |
| 46  | Error mapping                  | Framework and Prisma errors map to correct 4xx                    | **PASS** (after fix)                                                 | Findings P8-2, P8-3                                                                                                                               |
| 47  | Correlation                    | `X-Request-Id` echoed; ids reach jobs, events, audit              | **PASS**                                                             | e2e                                                                                                                                               |
| 48  | SSE — authorization            | Cross-tenant stream is `404` before a byte is written             | **PASS**                                                             | e2e                                                                                                                                               |
| 49  | SSE — delivery                 | An event on an owned book reaches the stream                      | **PASS** (after fixes)                                               | e2e "delivers its events", ~1s                                                                                                                    |
| 50  | SSE — payload safety           | Frames carry identifiers, never bulk content                      | **PASS**                                                             | e2e                                                                                                                                               |
| 51  | SSE — resumption               | `Last-Event-ID` replay and `stream.resync`                        | **PASS** (code) / **NOT TESTED**                                     | Implemented; no test drives a reconnect                                                                                                           |
| 52  | Capabilities honesty           | Unregistered fleet reports `available: null` + `degraded`         | **PASS**                                                             | `platform.service.test.ts`                                                                                                                        |
| 53  | Vocabulary drift               | Served vocabularies match the database enums                      | **PASS**                                                             | `platform.service.test.ts` asserts against the generated Prisma enums                                                                             |
| 54  | Fleet non-disclosure           | No worker/host/VRAM/queue detail in public responses              | **PASS**                                                             | `platform.service.test.ts` + e2e                                                                                                                  |
| 55  | Artifact download              | Signed URLs, no bytes through the application                     | **PASS** (pre-existing)                                              | `assembly.service.test.ts`, `tts.service.test.ts`                                                                                                 |
| 56  | Artifact versioning            | Historical versions remain immutable and reachable                | **PASS** (pre-existing, by construction)                             | `is_current` + version columns; not re-tested here                                                                                                |
| 57  | Index coverage                 | Progress and SSE read paths are index-served                      | **PASS** (applied) / **UNKNOWN** (measured)                          | Migration 0004; no `EXPLAIN` captured, no volume data                                                                                             |
| 58  | Large project                  | 100+ chapters, 10 000+ segments end to end                        | **NOT TESTED**                                                       | No dataset of that size exists; generating one needs the GPU path                                                                                 |
| 59  | API load test                  | Concurrent load on list/detail/progress/jobs                      | **NOT TESTED**                                                       | No load harness in this repo                                                                                                                      |
| 60  | Performance baseline           | Latency numbers for the new endpoints                             | **UNKNOWN**                                                          | **No numbers are published.** Nothing was measured under realistic data                                                                           |
| 61  | Failure injection              | Ingestion/Director/TTS/assembly/DB/queue/storage faults           | **PARTIAL** (pre-existing)                                           | `failure-injection.integration.test.ts` covers unreachable-Postgres readiness only                                                                |
| 62  | Full E2E through the app layer | Create → upload → generate → review → download                    | **PARTIAL**                                                          | `full-pipeline.e2e.test.ts` proves the engine path; the Phase 8 suite proves the application surfaces; the two have not been driven as one script |

---

## 4. Findings

### P8-1 — SSE streams were closed by Fastify immediately after opening (fixed)

The book and job event streams wrote their opening frame and then delivered
nothing, forever. Three defects stacked, and each masked the next:

1. **An empty-string cursor sentinel against a `uuid` column.** The initial
   keyset position used `eventId: ''`, which Prisma refuses to coerce for
   `@db.Uuid`: every poll failed with _"Error creating UUID, invalid length"_.
   The stream survived (the poll catches and continues) and silently delivered
   nothing. Fixed by making the cursor's `eventId` nullable, with the tie-break
   clause applied only once an anchor event exists.
2. **Teardown listened on the request, not the response.** `IncomingMessage`
   emits `close` when the request _message_ completes — and a `GET` has no
   body, so that fired almost immediately, tearing down every stream within
   milliseconds. Fixed by listening on `ServerResponse`.
3. **Fastify still owned the reply.** Without `reply.hijack()`, Fastify
   serializes and sends its own response when the handler's promise resolves,
   and this app's `onSend` hook (the default `Cache-Control: no-store`) runs
   too — both acting on a socket that already had headers and a frame written
   directly to it. The result was an immediate close. Fixed by hijacking.

Worth recording as one finding because the _symptom_ was identical in all three
cases and indistinguishable from "the pipeline produced no events" — the class
of bug where the observability is what fails, not the work.

Also fixed alongside: the **test's own reader** raced `reader.read()` against a
timer, orphaning the pending read and discarding every chunk after the first
timeout. That would have hidden a working server. Recorded because it was, for
a while, the leading suspect.

### P8-2 — Unrouted paths returned 500, not 404 (fixed)

`AllExceptionsFilter` mapped every framework `HttpException` to
`InternalError`. A client that mistyped a URL was told the server was broken,
and the mistake landed in the server-error logs to be triaged as an incident.
Now `404`, `405`, `400`, `413`, and `415` are preserved through the API's own
taxonomy; anything else still collapses to `INTERNAL_ERROR`, because a status
this API did not deliberately choose is not one it should assert.

This required adding a `METHOD_NOT_ALLOWED` category to `packages/errors` —
§9.1 and §9.2 make the `405`/`409` distinction "contractual and testable", and
the taxonomy previously had no way to express it.

### P8-3 — A malformed identifier returned 500, not 422 (fixed)

`GET /api/v1/jobs/not-a-uuid` returned `500 INTERNAL_ERROR`: Prisma raises
`P2023` for a value it cannot coerce to a `uuid` column, and it escaped
unhandled. **This is the same class as QA finding F-17** — the API accepts a
request the database then rejects. Now `422 INVALID_IDENTIFIER`, mapped
centrally at the boundary so a new endpoint inherits the behaviour rather than
needing to remember a guard.

F-17's own case (`POST .../previews` without `book_id`) is a different fix —
an API-contract decision about whether the field is optional — and remains
OPEN.

### P8-4 — Progress and SSE read paths had no index coverage (fixed)

An index audit (§87) found that none of the aggregates the progress endpoint
issues, and neither of the outbox tails the SSE endpoints issue, were served by
an existing index. `audio_script_chunk`, `audio_chunk`, `parsed_page`, `scene`,
`scene_semantics`, and `chapter` had **no** `(book_id, …)` index at all; every
poll was a sequential scan of the largest tables in the system.

Migration `0004_phase8_read_model_indexes` adds nine indexes, all additive.
Applied and verified against the live database.

**Caveat:** correctness of coverage was reasoned from the query shapes, not
measured. No `EXPLAIN` output was captured and there is no volume data to
measure against — row 57 is `UNKNOWN` for that reason.

### P8-5 — `book_counter` remains an unwritten cache (OPEN, unchanged)

`database-schema.md` §18.1 defines `book_counter` as a derived cache for
exactly the aggregates the progress endpoint computes. **It has no writer in
either runtime** — zero rows after a full pipeline run.

The progress endpoint therefore computes from source tables on every call. That
is correct and, with migration 0004, index-served; it is also more expensive
than reading one row. Deliberately not fixed here: populating the counter means
finding every mutation site in two runtimes and keeping them consistent, and
§31.2 forbids any gate or correctness decision reading it — so a wrong counter
would be silently wrong. It is a performance optimisation with a real
consistency design behind it, not a Phase 8 loose end.

### P8-6 — `worker` and `processing_attempt` still have no writer (OPEN, unchanged from F-26)

`GET /jobs/{id}/attempts` and `GET /admin/workers` are implemented and correct,
and both return empty in every deployment because nothing registers a worker or
records an attempt. §98's lineage chain Request → Job → **Worker** → Artifact
is still missing its Worker link.

The endpoints exist rather than being omitted because an empty fleet view is
itself the operational signal that registration is not running. `/capabilities`
reports this honestly: `degraded: true`,
`WORKER_CAPABILITY_REGISTRY_UNAVAILABLE`, and `available: null` per provider.

Unchanged from F-26 and for the same reason: writing attempt rows requires the
lease/fencing mechanism `context.md` §1250-1252 specifies, and inventing worker
ids and fencing tokens is precisely the drift that would have to be
disentangled later.

### P8-7 — Mid-job cancellation is not implemented (OPEN, bounded)

The worker cancellation check is at the **job boundary**: before a processor
starts, and therefore before every retry. That is the complete requirement
§29.3 states for `generate_tts_chunk`. It does **not** cover mid-job
boundaries — cancelling a `parse_book` already on page 200 of 400 will not stop
it before page 400.

The exposure is bounded by one job's duration rather than by the book's.
Implementing it properly means threading a cancellation callback through the
ingestion pipeline and the AI handlers' loops, which changes Phase 2/3
subsystems the brief scopes out. Reported rather than half-done: a
`finally`-block check that ran after the work finished would report
cancellation having already burned the full cost of not cancelling.

### P8-8 — Authentication endpoints are absent (OPEN, by scope) — **RESOLVED in Phase 10**

`/api/v1/auth/**` (§16.1) and `/users/me/sessions` (§16.2) are not implemented.
This deployment verifies an externally-issued RS256 bearer token, and §40 of
the brief says to use the existing authentication system rather than build a
second one.

`GET/DELETE /users/me/sessions` was deliberately **not** stubbed: the `session`
and `refresh_token` tables have no writer, so the endpoint would return `[]` in
a way indistinguishable from "you have no active sessions". Reporting a gap is
honest; an endpoint that always answers `[]` is not.

**Phase 10 resolution.** `apps/api/src/auth/` implements every `/auth/**`
endpoint §16.1 specifies, issuing tokens `JwtAuthGuard` verifies without any
change to that guard — issuance was additive, not a replacement authentication
system. `/users/me/sessions` now has a real writer (`Session`/`RefreshToken`
rows are created at login and rotated at refresh), so it answers truthfully.
See `docs/application/identity-and-account-architecture.md` and
`docs/qa/phase-10-quality-report.md`.

### P8-9 — Broken pgvector shared library in this environment (ENVIRONMENT)

Postgres has `vector 0.7.4` registered in `pg_extension` but `$libdir/vector`
missing on disk, so any statement whose plan touches a vector column fails with
`58P01`. Confirmed pre-existing by stashing every Phase 8 change.

Blocks: `worker-ai/tests/test_real_postgres_integration.py`, and `book`
deletion in test teardown. Nothing in Phase 8 reads or writes a vector column.
Same class as F-8; the fix is an infrastructure one (reinstall the extension
matching the running server binary).

---

## 5. Contract audit

Cross-checking the Phase 8 implementation against each architecture document.

| Document                        | Area                                                                                                             | Verdict                                                          | Note                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.md`                    | Book as the aggregate root; §4.1 soft deletion; §11.4 cooperative cancellation; §25.8 no invented job vocabulary | **MATCH**                                                        | `Project ≡ Book`; `deleted_at`; nine job states verbatim                                                                                                                     |
| `context.md`                    | §14.5 review surface                                                                                             | **DEVIATION (documented)**                                       | Mandated but not specified as an entity — §15.18 reserves it, OQ-3 open. Surfaced via `review_flags` + counters instead                                                      |
| `api-specification.md` §4.1     | Public resource tree                                                                                             | **MATCH** for everything implemented                             | `/auth/**` and `/users/me/sessions` absent — finding P8-8                                                                                                                    |
| §7.1–7.3                        | Envelope shapes, `202` semantics                                                                                 | **MATCH**                                                        | `data`/`page`, `object` on every resource, `202` never implies completion                                                                                                    |
| §7.7                            | `degraded` present where degradation is possible                                                                 | **MATCH**                                                        | progress, quotas, capabilities                                                                                                                                               |
| §8                              | Error envelope and prohibited content                                                                            | **MATCH**                                                        | verified by e2e                                                                                                                                                              |
| §9.1                            | Status code usage                                                                                                | **MATCH** (after P8-2, P8-3)                                     | `405` added to the taxonomy                                                                                                                                                  |
| §10                             | Cursor pagination, filter and sort allowlists                                                                    | **MATCH**                                                        | keyset cursors; enum-checked filters; indexed sort fields                                                                                                                    |
| §11                             | Idempotency where required                                                                                       | **MATCH**                                                        | book creation, uploads, stage commands, admin replay                                                                                                                         |
| §14.3                           | Rate limiting and quotas; never fleet backpressure                                                               | **MATCH**                                                        | quota guard derived from the request, never from queue depth                                                                                                                 |
| §14.11/§14.12                   | Sensitive error handling; auditing                                                                               | **MATCH**                                                        | audit writes identifiers only                                                                                                                                                |
| §16.2                           | Users, quotas                                                                                                    | **MATCH** partially                                              | sessions absent — P8-8                                                                                                                                                       |
| §16.5/§16.6                     | Book get/update/delete                                                                                           | **MATCH**                                                        | restore and purge implemented in Phase 10 (`docs/application/storage-lifecycle.md`)                                                                                          |
| §16.18                          | Jobs, attempts, cancellation                                                                                     | **MATCH**                                                        | attempts empty — P8-6                                                                                                                                                        |
| §16.19                          | Progress and event streams                                                                                       | **MATCH**                                                        | `Last-Event-ID` implemented, untested — row 51                                                                                                                               |
| §16.20                          | Access URLs                                                                                                      | **MATCH** (pre-existing)                                         | unchanged by Phase 8                                                                                                                                                         |
| §16.21                          | Capabilities, model versions                                                                                     | **MATCH** with honest degradation                                | `available: null` — P8-6                                                                                                                                                     |
| §16.22                          | Administration                                                                                                   | **MATCH**                                                        | all ten endpoints; `workers` empty — P8-6                                                                                                                                    |
| §20.1–20.5                      | State vocabularies                                                                                               | **MATCH**                                                        | no vocabulary invented or renamed                                                                                                                                            |
| §22                             | Versioning; additive change only                                                                                 | **MATCH**                                                        | every change adds a route, a field, or an index. No existing response shape narrowed, no status changed except the two bug fixes (P8-2, P8-3), both of which replace a `500` |
| `database-schema.md`            | Existing schema used as-is                                                                                       | **MATCH**                                                        | no table, column, or enum added. Migration 0004 is indexes only                                                                                                              |
| `database-schema.md` §18.1      | `book_counter`                                                                                                   | **DEVIATION (documented)**                                       | Defined but unwritten — P8-5                                                                                                                                                 |
| `event-contracts.md` §12        | 36 event names, none invented                                                                                    | **MATCH**                                                        | Phase 8 produces only `job.cancelled`                                                                                                                                        |
| `event-contracts.md` §19        | Transactional outbox                                                                                             | **MATCH**                                                        | `job.cancelled` written in the same transaction as the status change, in both runtimes                                                                                       |
| `event-contracts.md` §29        | Cancellation                                                                                                     | **MATCH** for §29.1, §29.2, §29.4, §29.5 · **PARTIAL** for §29.3 | mid-job check points — P8-7                                                                                                                                                  |
| `audio-script-ir.md`            | IR semantics                                                                                                     | **MATCH** (untouched)                                            | Phase 8 reads chunks, never writes IR                                                                                                                                        |
| `director-specification.md`     | Closed vocabularies                                                                                              | **MATCH**                                                        | `/capabilities` serves them, asserted against the DB enums                                                                                                                   |
| `tts-provider-specification.md` | Capability declarations                                                                                          | **UNKNOWN**                                                      | Declared in `worker_gpu/tts/capability.py`; reach the platform only through worker registration, which does not exist — P8-6                                                 |
| `deployment-architecture.md`    | Health/readiness surfaces                                                                                        | **MATCH** (unchanged)                                            | no new operational endpoint added                                                                                                                                            |
| `architecture-review.md`        | High-risk register                                                                                               | see §6                                                           |                                                                                                                                                                              |

**Overall: MATCH, with four documented deviations** (review entity, `/auth`,
`book_counter`, worker registry), each of which is a gap the architecture
itself leaves open or a subsystem that was never built — none invented by
Phase 8.

---

## 6. Phase 7 findings, re-checked

No finding disappears silently.

| Finding                                        | Phase 7 state       | Phase 8 verdict                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 cross-page hyphenation                     | fixed               | **RESOLVED** — untouched, test still green                                                                                                                                                                                                                                                                                             |
| F-2 orphaned dispatch                          | fixed               | **RESOLVED** — sweeper still green                                                                                                                                                                                                                                                                                                     |
| F-3 job idempotency                            | retracted           | **RESOLVED** (was never a defect)                                                                                                                                                                                                                                                                                                      |
| F-4 dispatch recovery for all job types        | fixed               | **RESOLVED** — Phase 8 relies on `dispatch_envelope` for admin replay, which exercises the same column                                                                                                                                                                                                                                 |
| F-5 audio clipping assertion                   | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-6 admin content boundary                     | fixed               | **RESOLVED and extended** — `PlatformAdminGuard` now makes the two surfaces provably disjoint (`platform-admin.guard.test.ts`)                                                                                                                                                                                                         |
| F-7 no rate limiting                           | fixed               | **RESOLVED** — Phase 8 adds `QuotaGuard` alongside, using the same derive-don't-decorate approach                                                                                                                                                                                                                                      |
| F-8 docker-compose pgvector image              | fixed               | **OPEN in this environment** — the running Postgres has a broken `vector` library (P8-9). Different instance of the same class                                                                                                                                                                                                         |
| F-9 order-dependent integration test           | pre-existing        | **OPEN** — not addressed; suite passes in file order                                                                                                                                                                                                                                                                                   |
| F-10 stale Phase-1 guard tests                 | pre-existing red    | **RESOLVED** — `workers-common` suite is green (166 tests). Appears to have been fixed after the scorecard was written                                                                                                                                                                                                                 |
| F-11 empty JWKS URL                            | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-12 undiagnosable 500s                        | fixed               | **RESOLVED, and it paid for itself** — the diagnostics F-12 added are what identified P8-1's first defect from a log line                                                                                                                                                                                                              |
| F-13 `pnpm start:dev`                          | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-14 Director generation                       | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-15 TTS unreachable                           | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-16 `book.current_audiobook_id` never written | open, dormant       | **OPEN, now surfaced** — the field is reported in the book resource with a comment naming the finding; `GET .../audiobook` remains the reliable pointer. Still a design call                                                                                                                                                           |
| F-17 missing optional field yields 500         | open                | **MITIGATED, not resolved** — the _class_ is fixed centrally (P8-3): Prisma constraint violations now map to 4xx. The specific `book_id`-on-preview case is an API-contract decision and remains OPEN                                                                                                                                  |
| F-19 `resource_type` enum                      | open, blocking      | **RESOLVED** — migration `0002` added `voice_preview` and `tts_job`. The scorecard text predates that migration                                                                                                                                                                                                                        |
| F-20 `schema:drift-check` red                  | pre-existing        | **UNKNOWN** — not re-run. Migration 0004 adds indexes, not tables, so the model-count assertion should be unaffected, but this was not verified                                                                                                                                                                                        |
| F-21 wrong status codes                        | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-24 concurrent jobs dead-lettered             | fixed               | **RESOLVED**                                                                                                                                                                                                                                                                                                                           |
| F-25 stage-6 E2E assertion                     | fixed               | **RESOLVED** — and the `audiobook_project` vs `audiobook` distinction it uncovered is now documented in `api-usage-guide.md` §11, so a client cannot repeat the mistake                                                                                                                                                                |
| F-26 worker identity / attempt lineage         | OPEN, not started   | **OPEN, unchanged** — see P8-6. Phase 8 exposes it honestly rather than hiding it                                                                                                                                                                                                                                                      |
| High-risk 1 (confident-but-wrong attribution)  | OPEN                | **OPEN** — no ground-truth corpus                                                                                                                                                                                                                                                                                                      |
| High-risk 2 (sequential analysis ceiling)      | UNKNOWN             | **UNKNOWN** — unbenchmarked                                                                                                                                                                                                                                                                                                            |
| High-risk 3 (voice consistency at length)      | UNKNOWN             | **UNKNOWN**                                                                                                                                                                                                                                                                                                                            |
| High-risk 4 (GPU scheduling)                   | UNKNOWN             | **UNKNOWN**                                                                                                                                                                                                                                                                                                                            |
| High-risk 5 (fan-out at 10k+ chunks)           | UNKNOWN             | **UNKNOWN** — Phase 8 bounds the _API_ response for that case (`active_job_ids` capped, aggregates fixed-count) but the queue behaviour is still unmeasured                                                                                                                                                                            |
| High-risk 6 (adversarial text)                 | partially mitigated | **UNCHANGED**                                                                                                                                                                                                                                                                                                                          |
| High-risk 7 (capability degradation UX)        | OPEN                | **PARTIALLY MITIGATED** — `capability_gaps` and `CAPABILITY_GAP` flags are now readable through the API, and `/capabilities` reports degradation honestly. The human review surface is still advisory                                                                                                                                  |
| High-risk 9 (TS/Python contract drift)         | CONFIRMED, systemic | **OPEN, and Phase 8 adds a sixth surface** — the cancellation flag key format now spans both runtimes. Mitigated deliberately: the format lives in one named function per runtime (`cancellationFlagKey` / `cancellation_flag_key`), each documenting the other, rather than being inlined at call sites. No mechanism yet enforces it |
| High-risk 10 / OQ-DIR-3 (advisory review gate) | OPEN                | **OPEN, unchanged** — Phase 8 surfaces flags but does not make the gate blocking; that is a product decision with no contract behind it                                                                                                                                                                                                |
| OQ-EV-2 / E-8 (`job.succeeded` event)          | OPEN                | **OPEN** — clients still learn of coordinator success by polling `GET /jobs/{id}`, which the usage guide documents                                                                                                                                                                                                                     |
| Assumptions 1, 4, 7                            | UNKNOWN             | **UNKNOWN**                                                                                                                                                                                                                                                                                                                            |

---

## 7. Readiness gate

| Dimension                       | Verdict                    | Basis                                                                                                                                                 |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application API completeness    | **READY WITH CONDITIONS**  | Every §16 surface a frontend needs is implemented except `/auth` (P8-8), which this deployment delegates to an external issuer                        |
| Frontend contract               | **READY**                  | A client can drive create → upload → generate → monitor → review → download without knowing about queues, workers, GPUs, model paths, or the database |
| Async correctness               | **READY**                  | No endpoint waits on an LLM, GPU, or ffmpeg; `202` semantics verified                                                                                 |
| Progress accuracy               | **READY**                  | Measured-only, unknown-is-null, monotonic, honest ETA — all tested                                                                                    |
| Cancellation                    | **READY WITH CONDITIONS**  | API and worker paths implemented and tested; mid-job check points missing (P8-7); not exercised against a live worker mid-job                         |
| Security — authentication       | **READY**                  | Every protected route verified                                                                                                                        |
| Security — authorization / IDOR | **READY**                  | Cross-tenant `404`, verified on book, progress, files, jobs, list, patch, delete                                                                      |
| Security — privilege separation | **READY**                  | Guard pair proven disjoint; six admin routes verified refused                                                                                         |
| Security — error hygiene        | **READY**                  | No internals leak; verified                                                                                                                           |
| Observability                   | **READY WITH CONDITIONS**  | Request → job → event → audit correlates. The **worker** link is missing (P8-6)                                                                       |
| API performance                 | **UNKNOWN**                | **No numbers are published.** Query shapes are bounded by design and index-served; nothing was measured                                               |
| Scalability                     | **UNKNOWN**                | No large-project or load test was run                                                                                                                 |
| Reliability                     | **UNCHANGED from Phase 7** | Phase 8 added no new failure mode; recovery posture is Phase 7's                                                                                      |
| Recoverability                  | **NOT READY**              | Unchanged — no tested backup or restore                                                                                                               |

**Overall: the backend is ready for a frontend to be built against, and not
ready for production.** Those are different claims. The API contract is
complete, tested, and safe for a client to depend on; production readiness is
still blocked by what Phase 7 identified — untested backup/restore, no measured
performance, no evaluated audio quality — none of which Phase 8 addressed or
claimed to.

---

## 8. Test inventory

**Added**

| File                                                      | Tests | Covers                                                                                                                                                                    |
| --------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/jobs/jobs.service.test.ts`                  | 23    | Cancellation state table, cascade, Redis fallback, replay, tenant scoping, field non-disclosure                                                                           |
| `apps/api/src/progress/progress.service.test.ts`          | 13    | Measured-not-inferred, unknown-vs-zero, monotonicity, ETA honesty, stage projection, bounded cost                                                                         |
| `apps/api/src/platform/platform.service.test.ts`          | 11    | Vocabulary drift vs DB enums, degraded capabilities, fleet non-disclosure, weights non-disclosure                                                                         |
| `apps/api/src/users/users.service.test.ts`                | 11    | ETag round-trip, stale `If-Match`, preference merge, fail-open quotas                                                                                                     |
| `apps/api/src/common/quota.service.test.ts`               | 7     | Fail-closed enforcement, no invented policy, non-propagating usage accounting                                                                                             |
| `apps/api/src/common/guards/platform-admin.guard.test.ts` | 6     | Admin admission, refusal, fail-closed, guard-pair disjointness                                                                                                            |
| `tests/e2e/application-layer.e2e.test.ts`                 | 58    | The whole surface over real HTTP: auth, IDOR, tenant isolation, escalation, cancellation, progress, concurrency, idempotency, lifecycle, capabilities, errors, audit, SSE |

**Totals:** `apps/api` unit tests 68 → **139**; e2e **58 new**; integration
unchanged at 43, all green.

---

## 9. Recommended Phase 9

In the order the evidence argues for, not the order that is easiest:

1. **Worker registry and attempt lineage (F-26 / P8-6).** It is the largest
   specified-but-unbuilt subsystem, it blocks honest capability reporting,
   cost attribution, orphan reaping, and stuck-job detection, and three Phase 8
   endpoints are correct-but-empty because of it.
2. **Measured performance.** Row 60 is `UNKNOWN` and nothing should be claimed
   about it until a realistic dataset exists. That means generating a
   100-chapter, 10 000-segment book and capturing latency for the endpoints a
   dashboard polls.
3. **Backup and restore.** The only `NOT READY` line on the gate, unchanged
   since Phase 7.
4. **A cross-runtime contract mechanism** for high-risk 9, now at six confirmed
   surfaces. Generated shared constants would have prevented five of them.
5. **Mid-job cancellation check points (P8-7)** and the review gate decision
   (high-risk 10) — both small, both needing a product answer first.

---

## 10. Stop

Phase 8 is complete as specified. No frontend was implemented. No
subscriptions, payments, marketplace, or recommendation features were added.

---

## Appendix — measured test results (2026-09-02)

Everything below was run on this machine, against real Postgres, Redis, and
MinIO, immediately before this report was written.

| Target | Result |
| --- | --- |
| `pnpm build` | **PASS** — all packages and apps compile |
| `pnpm lint` | **34 errors, all pre-existing** — verified by stashing every Phase 8 change and re-running, which produces the identical 34. Phase 8 introduced 11 and all 11 were fixed |
| `pnpm format` | Run, then **reverted on files Phase 8 did not otherwise touch**. It reformatted ~23 Phase 1–6 files whose committed form predates the format gate; keeping that churn would have tripled the diff and buried the actual change. `format:check` was already failing on those files before Phase 8 and still is — an unrelated cleanup, deliberately left for one |
| `pnpm test` (unit) | **PASS** — 278 tests. `apps/api` grew 68 → 139 |
| `pnpm test:contract` | **PASS** — 35 tests (the target was previously empty) |
| `pnpm test:integration` | **PASS** — 43 tests, 9 files |
| `pnpm test:e2e` | **PASS** — 82 tests, 4 files, including the pre-existing 7-stage `full-pipeline` run |
| `pnpm schema:drift-check` | **PASS** — all 10 checks, including after migration 0004 |
| `python workers-common` pytest | **PASS** — 166 tests |
| `python worker-ai` pytest | **1 FAIL** — `test_real_postgres_integration`, blocked by the broken `vector` library (P8-9). Fails identically on the clean tree |
| `python worker-gpu` mypy / ruff | **PASS** — no issues in 11 source files |

The `full-pipeline` e2e run passing unchanged is the load-bearing regression
check here: Phase 8 touched the exception filter, the guard chain, and the
books service, all of which sit in that test's path.
