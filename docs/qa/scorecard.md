# QA Scorecard — Phase 7, Milestone 1

> **Superseded in part by Phase 8.** Every finding below is re-checked in
> [`phase-8-report.md`](./phase-8-report.md) §6, which records each one as
> RESOLVED / MITIGATED / OPEN / UNKNOWN with evidence. Two entries here are
> known to be **stale**: F-19 was fixed by migration `0002`, and F-20's drift
> gate is now green (all 10 checks pass). Read this document for the Phase 7
> measurements and the Phase 8 report for their current status.

**Date:** 2026-09-01
**Scope:** what was measured on a local development machine (macOS, no GPU, no
container runtime; Postgres, Redis, and MinIO reachable on localhost).

Status vocabulary, applied strictly:

- **PASS** — measured, with evidence named below.
- **FAIL** — measured, and it does not hold.
- **UNKNOWN** — _not measured_. Never a synonym for "probably fine". A
  requirement with no test is `UNKNOWN` even when the code looks correct.

There is deliberately no single overall score. A rolled-up number would hide
exactly the rows that matter.

---

## 1. Scorecard

| #   | Category                               | What was checked                                                                                                            | Status                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Text fidelity                          | Source PDF → canonical text: no loss, duplication, or corruption of words, names, numbers, dates, punctuation, or non-ASCII | **PASS**                                   | `packages/ingestion/src/golden-book.test.ts` (counts, not just presence)                                                                                                                                                                                                                                                                                                |
| 2   | Text fidelity — hyphenation            | Line-break hyphenation rejoined within a page                                                                               | **PASS**                                   | same                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Text fidelity — hyphenation            | Hyphenation broken across a **page** boundary                                                                               | **PASS** (after fix)                       | Finding F-1; `golden-book.test.ts` (promoted from `it.fails` once it held)                                                                                                                                                                                                                                                                                              |
| 4   | OCR noise                              | Repeated header / bare page-number footer stripped, not narrated                                                            | **PASS**                                   | `golden-book.test.ts`, `pipeline.test.ts`                                                                                                                                                                                                                                                                                                                               |
| 5   | Structural fidelity                    | Chapter order and titles preserved                                                                                          | **PASS**                                   | `golden-book.test.ts`                                                                                                                                                                                                                                                                                                                                                   |
| 6   | Reproducibility (ingestion)            | Same bytes + config → same `contentHash` / `rawTextContentHash`                                                             | **PASS**                                   | `golden-book.test.ts`, `pipeline.test.ts`                                                                                                                                                                                                                                                                                                                               |
| 7   | Tenant isolation                       | Cross-tenant reads across all 6 business services                                                                           | **PASS**                                   | `tests/integration/tenant-isolation.security.integration.test.ts`                                                                                                                                                                                                                                                                                                       |
| 8   | IDOR                                   | ID substitution (own book id + foreign sub-resource id) for chapter, character, character-voice, aliases                    | **PASS**                                   | same                                                                                                                                                                                                                                                                                                                                                                    |
| 9   | IDOR                                   | ID substitution for AudioScript / AudioScriptChunk / AudioChunk / ChapterAudio / Audiobook                                  | **UNKNOWN**                                | Not tested — fixtures need the full StoryBible + ModelVersion + TTS lineage chain. Book-level gate for those services _is_ covered (row 7)                                                                                                                                                                                                                              |
| 10  | Prompt injection                       | Instruction-shaped dialogue, fake system prompts, tool-call and markup payloads cannot produce an unregistered speaker      | **PASS**                                   | `python/worker-ai/tests/test_prompt_injection_resistance.py`                                                                                                                                                                                                                                                                                                            |
| 11  | LLM output validation                  | Provider output schema has no speaker/instruction field; smuggled extra fields rejected, not dropped                        | **PASS**                                   | same                                                                                                                                                                                                                                                                                                                                                                    |
| 12  | Director validation                    | Unknown-speaker circuit breaker hard-fails a compromised run                                                                | **PASS**                                   | same, plus `test_director_validation.py`                                                                                                                                                                                                                                                                                                                                |
| 13  | Job dispatch reliability               | A job committed to Postgres but never enqueued to Redis is recovered                                                        | **PASS** (after fix)                       | Finding F-2; `tests/integration/processing-job-sweeper.integration.test.ts`                                                                                                                                                                                                                                                                                             |
| 14  | Idempotency (queue)                    | Re-enqueueing an already-queued job is a safe no-op                                                                         | **PASS**                                   | same test; BullMQ `addStandardJob` Lua jobId short-circuit                                                                                                                                                                                                                                                                                                              |
| 15  | Idempotency (HTTP)                     | `Idempotency-Key` dedup                                                                                                     | **PASS** (pre-existing)                    | `IdempotencyKey` unique index + `idempotency.service.ts`                                                                                                                                                                                                                                                                                                                |
| 16  | Idempotency (job records)              | DB-level uniqueness on `ProcessingJob.idempotencyKey`                                                                       | **PASS**                                   | Partial unique index verified against the live DB via `pg_indexes`. Previously reported as FAIL — see the retraction of F-3                                                                                                                                                                                                                                             |
| 17  | Outbox / inbox                         | Transactional outbox → relay → idempotent inbox                                                                             | **PASS** (mechanism) / **FAIL** (coverage) | Finding F-4 — real business job dispatch does not use it                                                                                                                                                                                                                                                                                                                |
| 18  | Retry / backoff / DLQ                  | Bounded retry, full-jitter backoff, dead-letter on exhaustion                                                               | **PASS**                                   | `tests/integration/queue.integration.test.ts`, `backoff.test.ts`                                                                                                                                                                                                                                                                                                        |
| 19  | Audio validation                       | Clipping, silence, sample rate, channels, duration checks                                                                   | **PASS** (after fix)                       | Finding F-5; `python/worker-gpu/tests/test_audio.py`                                                                                                                                                                                                                                                                                                                    |
| 20  | Assembly ordering                      | Scrambled chunk insertion still assembles in canonical order, verified from decoded audio                                   | **PASS** (pre-existing)                    | `assembly.integration.test.ts` bandpass check                                                                                                                                                                                                                                                                                                                           |
| 21  | Packaging                              | Real ffprobe-verifiable M4B with correct chapter markers and durations                                                      | **PASS** (pre-existing)                    | `assembly.integration.test.ts`                                                                                                                                                                                                                                                                                                                                          |
| 22  | Secret scan                            | Hard-coded credentials, hosts, ports, model paths in `apps/` and `python/`                                                  | **PASS**                                   | grep audit; only hit is a comment stating no such default exists                                                                                                                                                                                                                                                                                                        |
| 23  | Authorization — admin content boundary | `PLATFORM_ADMIN` refused on content surfaces and signed-URL minting (§6.6 MUST NOT)                                         | **PASS** (after fix)                       | Finding F-6; `TenantRoleGuard` + `tenant-role.guard.test.ts`                                                                                                                                                                                                                                                                                                            |
| 23a | Authorization — deny by default        | A principal with no tenant role, or a `SERVICE`/`WORKER` token, is refused on `/api/v1/**`                                  | **PASS** (after fix)                       | same                                                                                                                                                                                                                                                                                                                                                                    |
| 24  | Rate limiting                          | Per-bucket throttling on read / write / upload / expensive / access_url                                                     | **PASS** (after fix)                       | Finding F-7; `buckets.test.ts`, `rate-limit.integration.test.ts`                                                                                                                                                                                                                                                                                                        |
| 24a | Rate limiting — availability           | A Redis outage does not become an API outage                                                                                | **PASS**                                   | fail-open with a `degraded` signal; `rate-limit.integration.test.ts`                                                                                                                                                                                                                                                                                                    |
| 25  | Full-pipeline E2E                      | One book, upload → final audiobook, in a single run                                                                         | **PASS**                                   | `tests/e2e/full-pipeline.e2e.test.ts` chains upload → ingestion → analysis → **casting** → Director → TTS → assembly → packaged audiobook across both runtimes over real HTTP and real queues. All 7 stages green, twice consecutively. Reaching this required F-24 (concurrent jobs dead-lettered) and F-25 (the stage-6 assertion read a field the API never returns) |
| 25e | Casting → Director ordering            | Voices assignable before the Director, so every IR chunk carries a binding                                                  | **PASS** (after fix)                       | Finding F-22; stage 3 + stage 4's zero-unbound-chunks assertion                                                                                                                                                                                                                                                                                                         |
| 25d | Cross-language queue interop           | Node BullMQ producer → Python BullMQ consumer on the same queues                                                            | **PASS**                                   | same test; this is `architecture-review.md`'s High-Risk #9 surface, previously untested — and it is what surfaced F-14                                                                                                                                                                                                                                                  |
| 25a | HTTP contract E2E                      | Auth, authorization, isolation, idempotency, validation, error envelope against the running API                             | **PASS**                                   | `tests/e2e/api-http.e2e.test.ts` (15 checks) — a layer that previously had no coverage at all                                                                                                                                                                                                                                                                           |
| 25b | Cross-process text fidelity            | Golden-fixture text survives upload → storage → worker → DB → HTTP intact                                                   | **PASS**                                   | same ingestion E2E; asserts rejoined hyphenation and stripped page headers after the full crossing                                                                                                                                                                                                                                                                      |
| 25c | Artifact lineage                       | A produced BookVersion traces back to its job, book file, and parser/normalizer provenance                                  | **PASS**                                   | same                                                                                                                                                                                                                                                                                                                                                                    |
| 26  | Voice consistency at scale             | Same `VoiceProfileVersion` across distant chapters                                                                          | **UNKNOWN**                                | Requires the full-pipeline harness                                                                                                                                                                                                                                                                                                                                      |
| 27  | Speaker attribution accuracy           | Precision / recall / F1 against ground truth                                                                                | **UNKNOWN**                                | No labelled corpus exists yet                                                                                                                                                                                                                                                                                                                                           |
| 28  | Speaker embedding similarity           | Same-voice similarity across emotions and chapters                                                                          | **UNKNOWN**                                | Requires real TTS + GPU                                                                                                                                                                                                                                                                                                                                                 |
| 29  | Provider fallback                      | No silent provider switching under failure                                                                                  | **UNKNOWN** (code reviewed, not exercised) | `factory.py` selects one provider at startup; no runtime swap path found by inspection                                                                                                                                                                                                                                                                                  |
| 30  | Performance baseline                   | Ingestion / Director / TTS RTF / assembly throughput                                                                        | **UNKNOWN**                                | No GPU, no production-like host. **No numbers are published.**                                                                                                                                                                                                                                                                                                          |
| 31  | Load / concurrency                     | 1 → 50 concurrent users                                                                                                     | **UNKNOWN**                                | Not run                                                                                                                                                                                                                                                                                                                                                                 |
| 32  | Long-form                              | 10h+ / 20h+ audiobook, 100+ chapters, 100k segments                                                                         | **UNKNOWN**                                | Not run                                                                                                                                                                                                                                                                                                                                                                 |
| 33  | Large cast                             | 50+ characters, voice cache and VRAM behaviour                                                                              | **UNKNOWN**                                | Requires GPU                                                                                                                                                                                                                                                                                                                                                            |
| 34  | Memory / FD leaks                      | 1000+ job soak                                                                                                              | **UNKNOWN**                                | Not run                                                                                                                                                                                                                                                                                                                                                                 |
| 35  | Worker crash recovery                  | Kill a worker mid-job; job remains recoverable                                                                              | **UNKNOWN**                                | Not run (the sweeper covers the _dispatch_ crash window only)                                                                                                                                                                                                                                                                                                           |
| 36  | DB / queue / storage outage            | Behaviour and recovery per dependency                                                                                       | **PARTIAL**                                | `failure-injection.integration.test.ts` covers unreachable-Postgres readiness only                                                                                                                                                                                                                                                                                      |
| 37  | Deletion semantics                     | Book / voice / artifact deletion, no orphans                                                                                | **UNKNOWN**                                | Blocked in this environment — see Finding F-8                                                                                                                                                                                                                                                                                                                           |
| 44  | Schema drift gate                      | `pnpm schema:drift-check` passes on a clean tree                                                                            | **PASS** (after fix)                       | Finding F-20 — all 10 checks green; previously red since written                                                                                                                                                                                                                                                                                                        |
| 45  | Per-attempt worker lineage             | `ProcessingAttempt` rows recording which worker ran each attempt                                                            | **FAIL**                                   | No worker writes them — zero rows after a full pipeline run. §98 requires Request → Job → **Worker** → Artifact → Event; the Worker link is absent. Not a defect in shipped behaviour but an unbuilt subsystem — see F-26                                                                                                                                               |
| 38  | Backup / restore                       | Tested restore                                                                                                              | **UNKNOWN**                                | No infrastructure; `deployment-architecture.md` RPO/RTO remain provisional                                                                                                                                                                                                                                                                                              |
| 39  | Migration safety                       | Migrations against realistic data volume                                                                                    | **UNKNOWN**                                | Not run                                                                                                                                                                                                                                                                                                                                                                 |
| 40  | Human / subjective audio evaluation    | Naturalness, differentiation, continuity                                                                                    | **UNKNOWN**                                | No protocol run                                                                                                                                                                                                                                                                                                                                                         |
| 41  | Production-like boot (§163)            | API starts from documented config against real Postgres/Redis/MinIO, serves authenticated traffic                           | **PASS** (compiled build only)             | Now automated: every `pnpm test:e2e` run boots the compiled services. Originally a manual dry run, which uncovered F-11 and F-13                                                                                                                                                                                                                                        |
| 42  | Error observability (§100)             | An unhandled failure yields a diagnosable server-side record                                                                | **PASS** (after fix)                       | Finding F-12                                                                                                                                                                                                                                                                                                                                                            |
| 43  | Dev-loop startup                       | `pnpm start:dev` runs the API                                                                                               | **PASS** (after fix)                       | Finding F-13 — compiled dev loop; verified 401 not 500                                                                                                                                                                                                                                                                                                                  |

**Test suite totals as measured:** 228 TypeScript unit tests, all passing;
43 integration tests across 9 files, all passing; 24 end-to-end tests across 3
files against the compiled services, **all passing** — the full cross-language
pipeline (upload -> ingestion -> analysis -> casting -> Director -> TTS ->
assembly -> packaged audiobook) now completes end to end, verified on two
consecutive runs; 301 Python tests, **300 passing, 1 skipped, 0 failing**
(the last failure was F-8's, and needs the pgvector image from
`docker-compose.yml` — see that finding for the one manual step).

---

## 2. Findings

### F-1 — Cross-page hyphenation split a word across paragraphs (fixed)

Dehyphenation runs inside a single block's text, so a word broken by a **page**
break was never rejoined: the canonical text kept a dangling hyphen at the end
of one paragraph and resumed mid-word in the next ("…an extra-" / "ordinary
afternoon…"). TTS would narrate that as two broken words, and the paragraph no
longer matched its source sentence.

_(An earlier revision of this finding described the symptom as the string
"extra- ordinary" in canonical text. That was an artifact of the probe joining
paragraphs with a space; the real defect is the paragraph split above.)_

**Fixed** in `detect-structure.ts` by merging the two blocks, on the same
conservative evidence `dehyphenate` already uses — previous block ends with a
hyphen directly after a lowercase letter, next begins with a lowercase letter —
so legitimate suspended hyphens ("twenty- and thirty-year-olds"), which never
end a block, are untouched. `sourcePageEndNumber` is widened so locators still
bracket the true source range.

**`normalizationVersion` moved `normalize.v1` → `normalize.v2`**, because this
changes canonical text and therefore every downstream content hash. Historical
`BookVersion` rows stay attributable to the ruleset that produced them.

**The bump has a ripple worth knowing about.** Ingestion refuses to persist
without a registered `ModelVersion` for the normalizer identity it reports, so
the version change immediately broke every ingestion with _"No ModelVersion
normalize.v2 registered … Run the seed script"_ — in tests and, had it shipped
unnoticed, in any deployed environment too. `infra/scripts/seed.ts` and the
test fixtures were updated in step. **Any future `normalizationVersion` (or
parser/OCR version) change must update the seed script in the same commit**;
the no-provenance-no-write rule turns a version bump into a deployment step.

### F-2 — Jobs orphaned between commit and enqueue (fixed)

Every API service committed a `ProcessingJob` row and then, in a separate
non-transactional step, called `queueManager.enqueue(...)`. A crash or Redis
outage between the two left the row at `status=CREATED` forever with nothing to
pick it up, and no sweeper existed. The schema's `queuedAt` column — clearly
intended for exactly this — was never written anywhere in the codebase.

**Fixed:** `enqueueProcessingJob` (`packages/queue/src/dispatch.ts`) now stamps
`queuedAt` after a successful enqueue, and `ProcessingJobSweeper`
(`apps/worker-cpu/src/processing-job-sweeper.ts`) recovers rows still unqueued
past a staleness threshold. Re-enqueueing is safe because every enqueue uses the
`ProcessingJob` id as the BullMQ jobId, and BullMQ's Lua scripts short-circuit
on an existing jobId.

**Scoped to `parse_book`.** It is the pipeline entry point — losing it strands a
book with nothing left to retry. Other job types' payloads depend on data not
present on the `ProcessingJob` row (`remaining_chapter_ids`,
`story_bible_version_id`, …); reconstructing them would duplicate each
service's business logic inside the sweeper. **Recommended follow-up:** persist
the intended envelope as a `ProcessingJob.enqueuePayload` column at creation
time, then the sweeper generalizes to every job type.

### F-3 — RETRACTED: `ProcessingJob` idempotency _is_ DB-enforced

**This finding was wrong and is withdrawn.** It claimed
`ProcessingJob.idempotencyKey` carried no unique constraint and that
duplicate-job prevention rested on application code alone. It does not.

The constraint exists, is a _partial_ unique index, and matches
`database-schema.md` §21's description precisely — verified against the live
database, not just the migration:

```sql
CREATE UNIQUE INDEX processing_job_tenant_idempotency_key
  ON public.processing_job (tenant_id, idempotency_key)
  WHERE status <> ALL (ARRAY['FAILED','CANCELLED','DEAD_LETTERED']);
```

**Why I got it wrong, and the lesson:** I inferred it from the Prisma schema's
`@@index`/`@@unique` block, which shows no unique constraint on those columns.
Prisma cannot express a _partial_ unique index, so this one is hand-written in
`prisma/migrations/0001_init/migration.sql` (line 3097) — exactly the situation
`prisma/README.md` exists to describe. **The Prisma schema is not the authority
on this database's constraints; the migration is.** Any future audit of
constraints has to read the migration SQL, and preferably `pg_indexes` on a
live database, before concluding something is missing.

All three of §21's idempotency layers are therefore real: the HTTP
`IdempotencyKey` table, this partial unique index, and the artifact-identity
constraints (`TtsJob.dedupeKey` and friends).

### F-4 — Orphaned-dispatch recovery covered only `parse_book` (FIXED)

**This finding was originally mis-stated, and the correction matters more than
the fix.** It was filed as "job dispatch bypasses the outbox", with "route
dispatch through the outbox" named as the architecturally-aligned fix. Reading
`event-contracts.md` §3.1-3.2 before implementing that showed the opposite:

|              | Command                            | Event                                     |
| ------------ | ---------------------------------- | ----------------------------------------- |
| Means        | _"Please perform this operation."_ | _"This operation has happened."_          |
| Consumers    | **Exactly one**                    | Zero or more                              |
| Persisted as | A `processing_job` row             | An `outbox_message` row, then a broadcast |

Dispatching a command through the outbox would turn a command into an event —
precisely the conflation those sections exist to forbid. Dispatch bypassing the
outbox is **correct**, and the proposed fix would have been architectural drift
(§4) justified by a misreading. The `processing_job` row already _is_ the
durable record of the command.

The second half of the original claim was also wrong: real business events
**are** written through the outbox, from both runtimes (`assembly-chapter.ts`,
`assembly-audiobook.ts`, `assembly-encode.ts`, `analyze_scene.py`,
`build_story_bible_delta.py`, `writes_director.py`). The publisher's
"no downstream broadcast consumer yet" log is accurate rather than a defect:
the SSE/broadcast gateway (§19) is not built yet.

**What was actually wrong.** Dispatch is two non-transactional steps — commit
the row, then enqueue — and a crash between them strands the job forever. The
sweeper built for F-2 recovered only `parse_book`, because no other job type's
payload could be reconstructed from the row (`remaining_chapter_ids`,
`story_bible_version_id`, ...).

**Fix.** `processing_job.dispatch_envelope` (migration
`0003_processing_job_dispatch_envelope`) stores the queue envelope the service
intends to dispatch, written in the **same transaction** as the row. The
sweeper now re-dispatches any job type from the row's own recorded intent,
taking queue/jobName/maxAttempts from the row's existing columns. All 11
dispatch sites across both apps build their envelope **once** and use it for
both the persisted column and the enqueue, so the recorded intent and the
actual dispatch cannot drift.

Rows with a NULL envelope are skipped rather than guessed at — inventing a
payload would dispatch a job the service never described — and a queue name
this build does not recognise is logged and left, rather than cast.

**Regression tests** (`processing-job-sweeper.integration.test.ts`, 4 passing):
the original `parse_book` recovery and dedup cases, plus an `assemble_chapter`
job recovered generically (asserting it lands on the queue the _row_ names,
with the row's own payload) and a NULL-envelope row left untouched with
`queued_at` still NULL.

**Method note.** The two new tests first failed in a revealing pattern — 0 swept
where 1 was expected, then 1 where 0 was expected. The cause was not the query:
the test imports the sweeper through the package export, which resolves to
`dist/`, so it was exercising the **previously compiled** sweeper. Same class of
error as F-24's stale container: the code under test was not the code on disk.

### F-5 — Audio clipping test asserted the wrong property (fixed)

`test_full_scale_amplitude_is_flagged_as_clipping` expected >50% of samples at
full scale from a full-scale **sine**, which only reaches full scale at each
cycle peak (~2.8%). The detector was correct; the assertion was not. Rewritten
to assert what actually matters — the ratio clears the rejection threshold and
`run_worker_checks` fails on `true_peak_clipping`.

### F-6 — The administrator content boundary was unenforced (fixed)

**This finding was originally recorded as "no RBAC" — that framing was wrong,
and reading §6.5 closely corrected it.** The spec deliberately gives
`TENANT_OWNER` and `TENANT_MEMBER` _equal_ access to their tenant's books,
files, jobs, voices, and artifacts ("all `TENANT_MEMBER` principals have equal
access", §6.2), so the absence of an owner-vs-member distinction is the spec,
not a defect.

The real violation was narrower and more serious: §6.6 states as a **MUST NOT**
that `PLATFORM_ADMIN` can never read book text, canonical text, Story Bible
content, or audio bytes, and can never mint signed URLs for tenant artifacts —
and §16.20 requires `403 ADMIN_CONTENT_ACCESS_DENIED` specifically. Because
`principal.roles` was never read anywhere outside the guard, an admin token
carrying a `tenant_id` had full content access, including access-URL minting.
Deny-by-default (§6.1) was likewise unenforced: a token with no role at all, or
a `SERVICE`/`WORKER` token, was accepted on `/api/v1/**`.

**Fixed:** `TenantRoleGuard` (`apps/api/src/common/guards/tenant-role.guard.ts`),
applied to all six business controllers. Admin principals are refused with
`ADMIN_CONTENT_ACCESS_DENIED`; principals without a tenant role are refused with
`FORBIDDEN`. Both are `403`, not `404`, per §6.4 — the resource is in the
caller's own tenant, so hiding its existence would be confusing rather than
safer. Cross-tenant references remain `404` (row 7).

**Two judgment calls, flagged for review rather than buried.** (a) The admin
refusal applies whenever `PLATFORM_ADMIN` is present, _even alongside_ a tenant
role, because a boundary that can be stepped over by adding a second role to
the same token is advisory rather than enforced. If product intent is that one
human may hold both roles and use their own tenant normally, that is the single
line to revisit. (b) **This is a breaking change for token issuers:** tokens
that carry no `roles` claim are now refused. That is what deny-by-default
means, and there are no login endpoints in this codebase to migrate, but any
external issuer must now emit `TENANT_OWNER` or `TENANT_MEMBER`.

### F-7 — No rate limiting (fixed)

`api-specification.md` §14.3 specifies seven buckets. `QuotaExceededError`
(code `RATE_LIMITED`) existed in `packages/errors` and was referenced nowhere
else; no guard, interceptor, or middleware implemented throttling — including
on upload, pipeline starts, and access-URL minting.

**Fixed:** fixed-window counters in the already-shared Redis
(`apps/api/src/common/rate-limit/`), applied by `RateLimitGuard` to all six
business controllers, with `RateLimit-Limit/Remaining/Reset` headers and
`Retry-After` on `429`, per §14.3.

Design choices worth review: buckets are derived from method and path rather
than from a per-route decorator, because a decorator someone forgets to add
leaves that route _unlimited_ — the one failure mode a limiter must not have.
Limits are counted per user, per tenant, and per IP simultaneously (§14.3
requires all three); the per-tenant multiplier exists so a multi-seat tenant is
not held to one user's budget. **The numeric limits are unmeasured starting
points**, which is consistent with the spec calling them `configuration`, and
they are env-tunable. The limiter **fails open** on a Redis outage and reports
`degraded` — failing closed would convert a Redis blip into a total API outage;
the tradeoff is deliberate and the degraded path is logged and tested.

Two buckets from §14.3 are intentionally absent: `auth` (no auth endpoints are
implemented) and `stream` (no SSE endpoint exists). Adding either endpoint means
adding its bucket.

### F-8 — docker-compose pinned a Postgres image with no pgvector (FIXED)

Filed as a local environment quirk. It is a **repo defect**: `docker-compose.yml`
pinned `postgres:16.6-alpine`, which ships no pgvector, while
`0001_init/migration.sql:19` runs `CREATE EXTENSION IF NOT EXISTS "vector"`,
declares `narrative_embedding.embedding vector(1536)`, and builds an HNSW index
on it. A fresh `docker compose up` + migrate fails outright.

The running database showed the confusing half of this: `pg_extension` holds
`vector 0.7.4` while `$(pg_config --pkglibdir)/vector.so` does not exist — a
volume initialised under a pgvector image, later served by an image without the
library. Every vector operation then fails with
`could not access file "$libdir/vector"`, including the `book` cascade delete
that traverses `narrative_embedding`, so no book row could be deleted and
deletion semantics could not be exercised.

Note the drift check reports "required extensions installed" as PASS here: it
queries `pg_extension`, which is satisfied by the catalog row alone. It cannot
distinguish a registered extension from a _loadable_ one.

**Fix.** `docker-compose.yml` now pins `pgvector/pgvector:pg16` (same PG major,
so the on-disk format is unchanged). Verified on a throwaway container rather
than asserted: all three extensions create cleanly, `vector(1536)` and the exact
HNSW index from the migration build, `prisma migrate deploy` applies both
migrations from empty, and the previously failing
`test_real_postgres_integration.py` passes — the whole Python suite goes from
299 passed / 1 failed to **300 passed / 0 failed**.

**Applying it needs one manual step**, deliberately not taken here: the running
`audio-book-postgres-1` container must be recreated to pick up the new image
(`docker compose up -d --force-recreate postgres`). The `pgdata` volume is
retained, but it was initialised by an Alpine/musl build and would then be
served by a Debian/glibc one — Postgres may report a collation-version mismatch
on text indexes. For a dev database the clean path is to recreate the volume and
re-run migrate + seed; that discards local data, which is the owner's call, not
a QA fix to make unilaterally.

**One test assertion changed as a consequence.** With pgvector working,
`test_real_postgres_integration.py` reached an assertion it had never been able
to execute: `all characters are PROVISIONAL`. That predates F-22, which made
analysis create the NARRATOR/UNKNOWN sentinels (status `CONFIRMED`,
`is_sentinel = true`) so the narrator is castable before the Director runs. The
assertion now scopes to non-sentinel characters — preserving its real intent,
that _discovered_ characters are claims and must never be auto-confirmed — and
additionally asserts the sentinels exist and are CONFIRMED, pinning F-22.

### F-9 — `final-integration.test.ts` is order/state dependent (pre-existing)

Passes on a freshly obliterated `maintenance` queue, then fails on the next run
with `Record to update not found`, because the test leaves BullMQ entries in
Redis that its Postgres-only cleanup never removes. **Confirmed pre-existing:**
reproduced identically with all Phase 7 changes stashed. Not fixed — it is
outside this milestone's scope, and the fix (queue cleanup in `afterAll`)
belongs with whoever owns that test.

### F-11 — An empty `AUTH_JWT_JWKS_URL` made the API unstartable (fixed)

The cross-field auth check used `??`: `Boolean(v.AUTH_JWT_JWKS_URL ?? v.AUTH_JWT_PUBLIC_KEY)`.
An empty string is not nullish, so a _present-but-empty_ `AUTH_JWT_JWKS_URL`
short-circuited and the public key was never considered. `.env.example` ships
exactly that (`AUTH_JWT_JWKS_URL=`), so **an operator following the documented
setup and supplying a public key could not start the API at all** — it failed
with "one of AUTH_JWT_JWKS_URL or AUTH_JWT_PUBLIC_KEY must be set" while both
were, in effect, set. Found by attempting a production-like boot (§163).

**Fixed:** empty/whitespace env values normalize to `undefined` in
`authEnvSchema`, and the check uses `||`. Regression test in
`packages/config/src/index.test.ts`.

### F-12 — Unhandled 500s were undiagnosable (fixed)

`logError` recorded only `error_code` — and for any error without a taxonomy
code that is the literal string `UNKNOWN_ERROR`, with the message, class, and
stack all discarded. A production 500 therefore left nothing to debug from,
which fails spec §100's requirement that every failure carry a safe diagnostic.
This is over-redaction, not safety: §99 forbids logging book text, credentials,
and signed URLs, none of which an error message or stack contains.

**Fixed:** `logError` now emits `error_message` and `error_class` always, plus
`error_stack` and the cause chain for uncoded (genuinely unexpected) errors.
Everything still passes through `redactSensitiveFields`, and the client-facing
envelope is unchanged — §8.2's "no stack trace reaches the client" still holds.

This fix immediately proved itself: it is what identified F-13 below, which had
previously surfaced only as an opaque `INTERNAL_ERROR`.

### F-13 — `pnpm start:dev` could not run the API (fixed)

The README's documented local-dev command for the API is `start:dev`, which
runs `tsx watch src/main.ts`. tsx/esbuild does not implement TypeScript's
`emitDecoratorMetadata`, so NestJS gets no `design:paramtypes` and every
constructor injection by type resolves to `undefined`. Every authenticated
business endpoint then fails with `TypeError: Cannot read properties of
undefined (reading 'listBooks')` — an opaque `500 INTERNAL_ERROR` to the
caller. The compiled path (`pnpm start` → `node dist/main.js`, built by `tsc`)
works correctly; all HTTP verification in this milestone was done against it.

**Fixed** by compiling with `tsc` and running the compiled output under Node's
own watcher (`tsc -p tsconfig.json && node --watch dist/main.js`), plus a
`build:watch` script for rebuild-on-save. No new dependency, and the dev loop
now runs exactly what `start` runs. Verified: the API boots and an
unauthenticated request returns `401` where it previously returned `500`.
`worker-cpu` keeps `tsx watch` — it has no decorators and is unaffected.

**This is why no HTTP-level test caught it**: the repo had no test driving the
running API over HTTP. `tests/e2e/api-http.e2e.test.ts` now does, and carries an
explicit regression test for this signature.

### F-14 — Director generation failed 100% of the time (fixed) — **the most serious defect found so far**

Every `generate_director_ir` job failed against a real database:

```
NotNullViolationError: null value in column "updated_at"
of relation "audio_script_chunk_source" violates not-null constraint
```

`updated_at` is `NOT NULL` with **no database default**, because Prisma's
`@updatedAt` is maintained by the Prisma _client_ — so the generated DDL
carries no `DEFAULT`, and every writer outside Prisma must supply the column
itself. `worker-ai` writes through SQLAlchemy, and its INSERT into
`audio_script_chunk_source` omitted it.

**Blast radius, measured rather than assumed:** of the 17 tables the Python
workers INSERT into, this was the _only_ offending statement — the sibling
INSERT into `audio_script_chunk` three lines above already passes `:now, :now`,
and all other writers supply it correctly. One inconsistent statement.

**Impact:** Phase 4 was non-functional end to end. Since TTS and assembly
consume Director output, nothing downstream could run either — the pipeline
could not proceed past analysis on any real book. It survived because the
Python unit tests mock the database, and no test had ever driven Director
against real Postgres.

**This is exactly the risk `architecture-review.md` names as High-Risk #9** —
"two-language contract drift... the highest-probability long-term defect
source". The Prisma `@updatedAt` convention is invisible from Python. That
entry moves from a predicted risk to a demonstrated one.

**Fixed** in `writes_director.py` by supplying `created_at`/`updated_at`,
matching the convention every other writer already follows.

**Two follow-ups this exposes, both still open:**

1. _A failing Director job never reaches a terminal state._ Through every
   retry the `ProcessingJob` stayed `RUNNING` with `errorCode` NULL, and each
   attempt left another orphan `DRAFT` `AudioScript` behind. A permanently
   failing job should end `FAILED` with its error recorded — as the ingestion
   path does — and should not accumulate orphan rows. Related to F-3.
2. _The class of bug is not closed, only this instance._ Any future non-Prisma
   INSERT can reintroduce it. A cheap guard: a schema test asserting that
   every `updated_at` column either has a DB default or is written by a
   statement that sets it. `pnpm schema:drift-check` is the natural home.

### F-15 — TTS was unreachable for every book (fixed)

`TtsService.startTts` gates on `book.current_audio_script_id`, and a repo-wide
search found that column **read in exactly two places and written in none**.
The Director's `finalize_audio_script` marks the script `VALIDATED`/`is_current`,
supersedes the previous one, and sets `book.status = 'SCRIPTED'` — but never
sets the Book's pointer. So TTS refused every book with
`AUDIO_SCRIPT_NOT_VALIDATED`, however valid the script was.

Ingestion honours this same convention correctly (worker-cpu sets
`current_book_version_id` in the transaction that makes the version current);
the Director simply did not. Same TypeScript/Python seam as F-14, same family
of cause. **F-14 was masking it** — the Director never succeeded, so nothing
ever reached the TTS gate to discover the problem.

**Fixed** in `finalize_audio_script`, in the same transaction that makes the
script current.

### F-16 — `book.current_audiobook_id` is never written (open, dormant)

The same "current pointer" convention is unimplemented for audiobooks: nothing
writes the column, and the assembly API derives its `current_audiobook_id`
response field from the `Audiobook` table instead. Unlike F-15 nothing gates on
it, so it is dead schema rather than a live failure. Resolution is a design
call — populate it for consistency, or drop it — so it is recorded rather than
fixed.

### F-17 — A missing optional field yields 500, not 422 (open)

`POST /voice-profiles/:id/versions/:v/previews` with no `book_id` returns
`500 INTERNAL_ERROR`. `create-voice-preview.schema.json` marks `book_id`
optional, but the database requires it for this path:

```sql
CHECK ("book_id" IS NOT NULL OR "type" = 'cleanup_artifacts')
```

Every job type except `cleanup_artifacts` is book-scoped, so the API accepts a
request the database then rejects, and the Prisma error escapes as an
unhandled 500. Per §138/§139 a user input error must surface as a meaningful
4xx — a 500 tells the caller nothing and looks like a server fault.

Fix is either to make `book_id` required in the schema for this endpoint, or to
validate it in `createVoicePreviews` and raise `VALIDATION_FAILED`. Not fixed
here because it is an API-contract change (`api-specification.md` treats the
field as optional) and belongs with whoever owns that contract.

Worth noting the class: any endpoint that creates a `ProcessingJob` without a
`book_id` hits the same constraint. This is the only one this suite exercised.

### F-19 — worker-gpu writes `resource_type` values that do not exist (open, blocking)

Voice preview generation fails 100% of the time, _after_ successfully
rendering and uploading the audio:

```
InvalidTextRepresentationError: invalid input value for enum resource_type: "voice_preview"
  UPDATE processing_job SET status='SUCCEEDED', ..., result_resource_type = 'voice_preview'
```

`worker-gpu` reports two `result_resource_type` values that are not in the
`resource_type` enum — verified against the live database via `pg_enum`, not
just the schema file:

| written by                                | value           | in enum? |
| ----------------------------------------- | --------------- | -------- |
| `generate_voice_preview.py:55` and `:138` | `voice_preview` | **no**   |
| `generate_tts_chunk.py:74`                | `tts_job`       | **no**   |
| `generate_tts_chunk.py:98,216`            | `audio_chunk`   | yes      |

So preview generation is dead on both of its success paths, and TTS chunk
generation has the **same latent failure** on its already-terminal/redelivery
path (`:74`) — which a redelivered or retried job would hit, while the normal
path at `:216` is fine. That second one is the more dangerous of the two: it
fails only on retry, exactly when things are already going wrong.

**This is a contract question, not a clear bug, so it is reported rather than
fixed.** `database-schema.md` §2699 lists the enum exactly as implemented, so
the migration is faithful to the documented contract and it is the workers that
step outside it. But `VoicePreview` and `TtsJob` are real tables, and a job
whose _result_ is one of them has no way to say so. Two defensible resolutions:

1. **Extend the vocabulary** — add `voice_preview` and `tts_job` to the enum
   (an additive `ALTER TYPE ... ADD VALUE` migration) and update
   `database-schema.md` §2699 plus `api-specification.md` §16.18's
   `related_resource.type`. Semantically right; changes a documented contract.
2. **Use an existing value** — e.g. report the preview against
   `voice_profile_version`. Cheaper, but the id would then not match the type,
   which is worse data than the crash.

Recommendation is (1). Either way **the pipeline cannot progress past casting
until this is decided**, which is why it is flagged as blocking rather than
filed for later.

### F-20 — `pnpm schema:drift-check` is red on a clean tree (pre-existing)

The repo's own schema-drift gate fails its `base table count matches
schema.prisma (59 models…)` assertion. **Confirmed pre-existing** by stashing
every Phase 7 change and re-running — it fails identically. Every other check in
that script passes, including the extension, outbox/inbox, partitioning, and
partial-unique-index assertions.

Not diagnosed further here (it is a counting assertion, not a correctness one,
and unrelated to this milestone's work), but it matters for a different reason:
a drift gate that is already red cannot detect the next real drift. Given that
F-3's retraction turned on exactly this class of question — what the database
actually contains versus what `schema.prisma` says — this check is worth
getting green.

### F-21 — Nine endpoints returned 201 where the spec requires 200 (fixed)

F-18 turned out to be one instance of a systemic problem. A scan of every
`@Post`/`@Put` handler found eleven that set no status at all, so NestJS's
`@Post` default (`201 Created`) was sent regardless of what the endpoint
actually does. Nine of them are specified as `200`, and `201` is not among
their documented status codes:

| endpoint                                                                                                                               | spec                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `POST .../text/access-urls`, `.../audio-chunks/:id/access-urls`, `.../chapter-audio/:id/access-urls`, `.../audiobooks/:id/access-urls` | §16.20 — `200`                       |
| `POST .../versions/:v/approval`                                                                                                        | `200` with the updated version       |
| `POST .../versions/:v/lock`, `.../retirement`                                                                                          | `200`                                |
| `PUT .../characters/:id/voice`                                                                                                         | `200`                                |
| `POST .../casting/narrator-fallback`                                                                                                   | `200` with the updated casting state |

None of these creates a resource. Access-URL minting in particular returns a
short-lived credential for an _existing_ object, and `201` implies a new
resource at a new location — the opposite of what §16.20 describes.

**Fixed** with `@HttpCode(200)` on all nine. The two remaining defaults
(`createVoiceProfile`, `createVersion`) are genuine creations, so `201` is
correct there and they were deliberately left alone.

Worth noting how this class hides: a wrong-but-successful status is invisible
to any test that only asserts the response body, and every one of these
endpoints _worked_ — they just announced the wrong thing. It took an E2E test
asserting the documented status code to surface it.

### F-24 — Concurrent jobs dead-lettered by a per-process health state machine (FIXED)

**Two independent causes, stacked.** The first masked the second, which is why
several confident intermediate conclusions in this investigation were wrong.

**Symptom.** After a full run, a varying subset of `AudioChunk` rows stayed
`GENERATED` instead of `VALIDATED`, and a chapter's `assemble_chapter` job
never ran. Assembly requires every chunk to be `VALIDATED`, so the pipeline
stopped. Observed splits across consecutive runs: 2/10, 3/9, 8/4, 9/3, 7/5.

**Cause 1 — a containerised worker on the same broker (test environment).**
A `worker-gpu` container had been running for 25 hours on an image predating
the F-23 fix. `docker-compose` points at the same Redis the E2E harness uses,
so it competed for `gpu` jobs with the harness's freshly built worker: its
stale code wrote `GENERATED`, the new code wrote `VALIDATED`, and each run's
chunks were split between them at random.

This also explains the observation previously recorded here as an unresolvable
paradox. `assertNoStaleWorkers()` shells out to `ps`, which sees only _host_
processes — a container is invisible to it **in principle**, not by accident.
The guard could never have caught this, and its silence was read as evidence of
absence. `assertNoWorkerContainers()` now closes that gap, failing loudly when
worker or API containers are running, while leaving postgres/redis/minio up.

**Cause 2 — `WorkerHealthStateMachine` driven per-job (product defect).**
With the container stopped, TTS went fully green but one chapter still stranded.
The BullMQ job hash held the answer:

```
failedReason: "Cannot transition from PROCESSING to PROCESSING"
  at WorkerHealthStateMachine.transition (packages/observability/dist/health.js:36)
  at worker-cpu/dist/main.js:112
```

`PROCESSING`/`IDLE` describe the _process_, but each job called `transition()`
directly. A worker runs `concurrency` jobs at once, so the second overlapping
job threw **out of the BullMQ process function, before any handler logic ran**.
The job failed, retried into the same collision, and dead-lettered — while its
`ProcessingJob` row stayed at `CREATED`/`attempt_count = 0`, because nothing had
touched it yet. That combination (a job in the DLQ, its row untouched) is what
made the failure look like a lost dispatch rather than a crash.

worker-cpu shares **one** state machine across four queue workers, so this needs
only two jobs to overlap anywhere in the process — including across different
queues at `concurrency: 1`. The same lines held a mirror-image bug: the first
job to finish flipped the whole process to `IDLE` while its siblings were still
running (a readiness lie), and the last one's `finally` then hit an
`IDLE -> IDLE` throw that masked whatever real error was propagating through it.

**Fix.** Reference-count in-flight jobs: `beginWork()`/`endWork()` transition
only at the 0<->1 boundaries, with a DRAINING guard so a job unwinding during
shutdown cannot drag the process back to `IDLE`. This is **not** a new design —
`python/workers-common/src/workers_common/health.py` already implements exactly
this (`job_started`/`job_finished`, in-flight counter, same DRAINING guard).
TypeScript was the outlier, so the fix restores an existing cross-runtime
contract rather than adding a layer (§4). This is the **fifth** confirmed
instance of architecture-review High-Risk #9 (TypeScript/Python contract drift),
which is now better read as a systemic issue than as five separate findings.

**Regression tests.** `packages/observability/src/health.test.ts` pins all four
behaviours: overlapping `beginWork()` does not throw; the process stays
`PROCESSING` until the last job finishes; `endWork()` is safe from a `finally`
during DRAINING; and the count never goes negative.

**Method note, recorded because it cost the most.** Five separate measurement
instruments produced confident wrong answers here: a poll treating an empty set
as complete, log _tails_ counted as totals, a process guard blind to containers,
and — the one that did the most damage — comparing a PID stamp taken in one run
against a `ps` sample taken in a _different_ run, then reporting the mismatch as
an impossible fact. When evidence looks impossible, the instrument is the first
suspect, not the system. The measurements that actually resolved this were the
_full_ worker log on disk (5 completions against 12 chunks, which pointed
outside the harness) and the BullMQ job hash in Redis (which named the throw).

**A caution for whoever picks this up.** Most of the time spent on this went to
faulty measurement, not to the defect: a poll that treated an empty set as
"complete", log _tails_ counted as totals, assertions that discarded the logs
explaining them, and a stale-process guard that matched the observer's own
command line. Trust an instrument here only after checking it reports correctly
on a known input.

### F-10 — Four stale Phase-1 guard tests (pre-existing)

`python/workers-common/tests/test_runtime_lifecycle.py` still asserts that
Phase 4/5 features do not exist: `generate_director_ir` "must not exist yet",
`StubTTSProvider` should be importable, model id should be `stub-model-v0`.
Those phases have shipped, so the suite has been red since Phase 4 landed.
These need updating to assert current reality; what each guard _should_ now
assert is a call for whoever owns the phase boundaries, so they are reported
rather than rewritten here.

### F-25 — The stage-6 E2E assertion read a field the API never returns (FIXED)

`full-pipeline.e2e.test.ts` polled `/books/:id/audiobook` for
`status === 'READY'`. That endpoint returns an `audiobook_project`, whose
lifecycle field is `generation_status`
(`NOT_STARTED|BLOCKED|ASSEMBLING|COMPLETED|FAILED|STALE`,
`api-specification.md` §20.10), with duration under `totals`. It has no
top-level `status` and no top-level `duration_ms`. The poll therefore read
`undefined` forever and could only ever time out — the assertion could not have
passed even against a perfectly healthy pipeline, and its timeout looked exactly
like a pipeline hang.

`READY` belongs to the `audiobook` entity, a **separate resource** reached via
the project's `current` link. The API was correct throughout; the test was
asserting a shape that never existed. It now polls `generation_status`, then
follows `current_audiobook_id` to assert `READY` and a positive duration on the
audiobook itself — preserving the original intent against the real contract.

### F-26 — Worker identity and per-attempt lineage are unimplemented (OPEN, not started)

`processing_attempt` and `worker` have **no writer in either runtime** — zero
rows after a full pipeline run. §98's lineage chain Request → Job → **Worker** →
Artifact → Event is missing its Worker link, so "which worker produced this
audio, running which model versions, on which attempt" is unanswerable, and
`resource_usage`-derived cost attribution (architecture-review.md §1467) has no
data behind it.

This is **not a defect in shipped behaviour** — it is a specified subsystem that
was never built, surfaced by QA rather than broken by it.

**Deliberately not implemented here, and the reason is the schema itself.**
`ProcessingAttempt.workerId` is a required UUID and `leaseFence` a required
BigInt. Those are not bookkeeping columns: they are the interface to the
lease/fencing-token mechanism that `context.md` §1250-1252 and
`event-contracts.md` §21.6 specify for orphan reaping — heartbeat-renewed leases
where the fencing token is what stops a reaped worker writing a stale result.
Writing attempt rows without that mechanism would mean **inventing** worker ids
and fencing tokens: precisely the architectural drift §4 forbids, and it would
leave a table full of meaningless fences for a real implementation to
disentangle. A worker registry with heartbeats, capability-based routing,
lease acquisition and orphan reaping, in both runtimes, is a feature-sized piece
of work with real design decisions — not a QA fix to improvise at the end of a
hardening pass.

Recorded as **FAIL** for row 45 and OPEN here, per §162: untested and unbuilt is
reported as such, never quietly downgraded.

---

## 3. Architecture-review register, re-checked

Re-verification of `architecture-review.md` (spec §117). Nothing is marked
resolved on the strength of documentation alone.

| Item                    | Original claim                                                          | Verified status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKER-1               | Outbox/Inbox tables missing from schema                                 | **RESOLVED** — `outbox_message` and `event_inbox` exist in `prisma/schema.prisma` with working implementations, and real business events from both runtimes are written through the outbox. Job _dispatch_ correctly does not use it: a command is a `processing_job` row, not an event (`event-contracts.md` §3.1) — see F-4, where this scorecard's earlier claim to the contrary is corrected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| BLOCKER-2               | `deployment-architecture.md` missing                                    | **RESOLVED** — document exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| High-risk 1             | Confident-but-wrong speaker attribution not automatically caught        | **OPEN** — unchanged; no ground-truth corpus (row 27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| High-risk 2             | Sequential narrative analysis is a throughput ceiling                   | **UNKNOWN** — unbenchmarked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| High-risk 3             | Voice consistency across a 20h audiobook                                | **UNKNOWN** — row 26                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| High-risk 4             | GPU scheduling under load                                               | **UNKNOWN** — no GPU                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| High-risk 5             | Queue fan-out/fan-in at 10k+ chunks                                     | **UNKNOWN** — not load tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| High-risk 6             | Text integrity under adversarial input                                  | **PARTIALLY MITIGATED** — golden fixture + injection suite now cover it; F-1 is one measured gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| High-risk 7             | Provider capability degradation UX                                      | **OPEN** — `capability.py` negotiation is unit-tested; the human review surface is not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| High-risk 9             | TS/Python contract drift, "highest-probability long-term defect source" | **CONFIRMED — five separate instances, and the prediction now looks understated.** F-14 is the severe case: a Prisma-managed `@updatedAt` convention, invisible from Python, broke Director generation completely. F-15 and F-19 are the same shape. F-24 is the newest and most expensive: `WorkerHealthStateMachine` was driven per-job in TypeScript while Python's `workers_common/health.py` already reference-counted in-flight jobs with an identical DRAINING guard — the runtimes had **diverging implementations of the same contract**, and the TypeScript side dead-lettered any two overlapping jobs. F-10 and the uppercase/lowercase `LOG_LEVEL` split are milder instances. At five confirmed cases this is better treated as a systemic gap (no mechanism enforces cross-runtime contracts) than as a list of individual bugs. Partially mitigated: the cross-language path now has a full E2E test (row 25); the _class_ of drift is still unguarded |
| High-risk 10 / OQ-DIR-3 | Advisory-only review gate                                               | **OPEN** — unchanged, still advisory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Assumption 1            | Postgres HA/backup posture                                              | **UNKNOWN** — rows 38-39; RPO/RTO still provisional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Assumption 4            | TTS models fit realistic VRAM                                           | **UNKNOWN** — unbenchmarked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Assumption 7            | LLM structured-output reliability within 2-3 attempts                   | **UNKNOWN** — unbenchmarked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OQ-EV-2 / E-8           | Generic `job.succeeded` event                                           | **OPEN** — still absent, as carried forward                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 4. Readiness gate

| Dimension                   | Verdict                   | Basis                                                                                                                                                                                                  |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Functional correctness      | **READY WITH CONDITIONS** | Upload → parsed chapters is now proven end to end across processes (row 25); the analysis → Director → TTS → assembly chain is still only covered stage by stage                                       |
| Text fidelity               | **READY WITH CONDITIONS** | Gate passes; F-1 is a known, bounded corruption                                                                                                                                                        |
| Security — tenant isolation | **READY**                 | Measured across all six services, both attack shapes                                                                                                                                                   |
| Security — authorization    | **READY WITH CONDITIONS** | F-6 and F-7 fixed and tested; rate-limit numbers are unmeasured defaults, and the admin+tenant-role interpretation needs product confirmation                                                          |
| Audio quality               | **UNKNOWN**               | No real-model output has been evaluated, objectively or subjectively                                                                                                                                   |
| Scalability                 | **UNKNOWN**               | Nothing load tested; no performance numbers exist and none are published                                                                                                                               |
| Reliability                 | **READY WITH CONDITIONS** | Retry/backoff/DLQ and the dispatch window are covered; crash and outage recovery are not (rows 35-36)                                                                                                  |
| Observability               | **READY WITH CONDITIONS** | Error diagnostics fixed (F-12); metrics, tracing, dashboards, and alerting are still unaudited                                                                                                         |
| Deployability               | **READY WITH CONDITIONS** | The compiled build boots and serves authenticated traffic against real dependencies (row 41); the documented dev command does not (F-13), and `.env.example` produced an unstartable config until F-11 |
| Recoverability              | **NOT READY**             | No tested backup or restore (row 38)                                                                                                                                                                   |

**Overall: NOT READY for production**, now driven by recoverability (no tested
backup or restore) and the complete absence of measured performance and audio
quality data. Authorization moved off the blocking list once F-6 and F-7 were
fixed. This is a statement about what has been _measured_, not a claim that the
untested areas are broken.
