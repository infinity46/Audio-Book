# Storage Lifecycle — Phase 10

> **Status:** Phase 10. Describes what is implemented, not what is planned.
> The three-tier model (soft delete / retention cleanup / hard purge) is
> fully specified in `database-schema.md` §27; this document records what
> Phase 10 actually built against that specification and where it stops.

---

## 1. The three operations, and what Phase 10 changed

| Operation | Phase 8 | Phase 10 |
| --- | --- | --- |
| **Soft delete** (`DELETE /books/{id}`) | Implemented — `deletedAt` stamp, refuses while jobs active, retains every artifact | Unchanged |
| **Retention cleanup** (bytes expire, row stays) | Schema support only (`storage_class` column, no writer) | **Implemented** — `runRetentionSweep`, §4 |
| **Hard purge** (`POST /books/{id}/purge`) | Not implemented; controller docstring named it as deliberately out of scope | **Implemented** — `POST .../restoration` + `POST .../purge`, §3 |

## 2. Retention windows — configuration, centralized

`database-schema.md` §27.5: *"windows are configuration... the schema stores
what is needed to apply them without embedding policy."* Phase 10 picks
concrete values and centralizes them in `packages/config`'s
`retentionEnvSchema` — one schema, imported by both `apps/api` (restoration
eligibility) and `apps/worker-cpu` (the sweep itself), rather than a literal
repeated in two runtimes:

| Setting | Default | Env var |
| --- | --- | --- |
| Soft-delete-to-purge-eligible window | 30 days | `RETENTION_SOFT_DELETE_DAYS` |
| Orphaned/failed artifact TTL | 48 hours | `RETENTION_ORPHAN_ARTIFACT_TTL_HOURS` |
| Sweep interval | 6 hours | `RETENTION_SWEEP_INTERVAL_MS` |

These are product defaults, not architecturally derived numbers — same
status as every other tunable in `packages/config` (rate-limit thresholds,
auth token TTLs): a starting point to revisit against real usage, not a
researched constant.

## 3. Book restoration and purge (`api-specification.md` §16.6.2/§16.6.3)

**Restoration** (`BooksService.restoreBook`) clears `deletedAt` and nothing
else — never touches `status`, matching *"restoration never advances or
rewinds the pipeline."* `TENANT_OWNER`-only (`requireRole`, stricter than
the controller's tenant-membership guard). `409 INVALID_STATE_TRANSITION` if
the book is not currently deleted.

**Purge** (`BooksService.purgeBook`) validates preconditions — soft-deleted,
no active jobs, `confirm_book_id` matches the path id, `Idempotency-Key`
present — then creates a `cleanup_artifacts` `ProcessingJob` and dispatches
it directly via `enqueueProcessingJob` (the same low-latency path
`parse_book` uses, not the Phase 1 outbox-relay path, which exists only to
prove that one plumbing test and wraps payloads in an unrelated shape).
Returns `202` with a job handle — purge is asynchronous because it can
delete millions of objects, exactly as the spec requires.

## 4. The purge worker — `database-schema.md` §27.4's 17 steps

`apps/worker-cpu/src/processors/maintenance.ts`'s `runPurgeBook` executes
the bottom-up order verbatim: audiobook renditions/covers → audiobook →
chapter audio → audio chunks → TTS jobs → audio script (chunks, sources) →
voice previews/assignments → book-scoped voice profiles (+ versions) →
Story Bible and every narrative-fact table → pronunciation entries →
characters (aliases, merges) → structural spine (paragraphs → scenes →
sections → chapters → parsed pages) → book versions → book files →
processing attempts/dependencies/jobs → book counter → the book row itself
→ finally, the audit row.

**Object-before-row, always.** Every artifact-bearing step deletes the
object-storage bytes first, then the database row — never the reverse, so a
crash mid-step can never leave a row pointing at bytes that are already
gone.

**Idempotent by construction, not by a resume checkpoint.** Each step is its
own statement; a `deleteMany` matching zero rows or a `storage.delete` on an
already-absent key is success, not an error. A retried purge (BullMQ
at-least-once redelivery, or a manual retry after a step failed) simply
re-runs from the top and every already-completed step is a fast no-op —
verified in `maintenance-purge.test.ts`'s idempotency test.

**Never deletes a shared object.** `purgeBookFiles` checks, per file, whether
any `BookFile` row *outside this book* still references the same storage
key before deleting the object (`database-schema.md` §27.3: never delete an
object another row still points at) — the dedup case. Row deletion always
proceeds; only the object delete is conditional.

**The purge job survives its own cleanup step.** Step 15
(`processing_attempt`, `job_dependency`, `processing_job`) explicitly
excludes the currently-running purge `ProcessingJob` — it is what is
performing the deletion, and needs to persist long enough to be marked
`SUCCEEDED` once every step (including this one) completes.

**Failure leaves the job retryable, never partially reported as done.** A
thrown error anywhere marks the job `FAILED` with `errorClass`/
`errorMessage` and re-throws (so BullMQ's own retry mechanism sees the
failure); nothing marks `SUCCEEDED` until step 17 actually runs.

**The closing audit row is the purge's durable signature.** Step 17 writes
`audit_log: BOOK_PURGED` — never deleted, per §27.3, and it is the row
`BookPurgeGuard` (see §6) checks to answer "is this book gone" even though
the `book` row itself no longer exists.

## 5. Retention sweep — expires bytes, never rows

`runRetentionSweep` is deliberately **not** built on the `ProcessingJob`
table: every `ProcessingJob` row requires a `tenant_id`, but a retention
sweep is cross-tenant by nature (§27.5 gives no single tenant to attribute a
global scan to). Instead, `RetentionSweeper`
(`apps/worker-cpu/src/retention-sweeper.ts`) mirrors the existing
`ProcessingJobSweeper`'s shape exactly — an in-process `setTimeout` loop, one
instance per worker replica, `start()`/`stop()` wired into the same
graceful-shutdown sequence.

Two sub-responsibilities, both transition `storage_class → EXPIRED` and
clear nothing else — **the row is always retained**, matching §27.1's
"retention cleanup... retains the row and its lineage":

1. **Orphaned uploads.** A `BookFile` with `status: 'REJECTED'` older than
   the orphan TTL has failed validation and nothing will ever admit it — its
   bytes are pure cost past the diagnosis window (§27.5: "failed artifacts
   retained for diagnosis for a bounded window, then expired"). An
   `ADMITTED` file, however old, is never touched by this path.
2. **Superseded audio chunks.** An `AudioChunk` with `isCurrent: false` is,
   by construction, unreferenced by anything live — but this only
   transitions it once its book **additionally** has `status: 'COMPLETED'`
   with a current audiobook set, older than the retention window. This is
   the conservative reading of §27.5's *"never while the audiobook is
   regenerable-on-demand and the user retains edit rights"*: a book still
   mid-pipeline might yet fall back to an older chunk, so nothing there is
   touched regardless of chunk age.

## 6. `BookPurgeGuard` — how `410 RESOURCE_PURGED` reaches every endpoint

`api-specification.md` §16.6.3: *"After the job succeeds, every endpoint for
this `bookId` returns `410 RESOURCE_PURGED`."* Since the purge deletes the
`book` row itself, a plain ownership lookup after that point would 404 —
indistinguishable from a `bookId` that never existed, the wrong signal for a
client that just watched its own purge job succeed.

Rather than threading a purge check through the seven services that call
`assertTenantOwnership` (books, director, analysis, assembly, tts, voice,
progress) — a far larger, more error-prone change for the same outcome —
this is one guard (`apps/api/src/common/guards/book-purge.guard.ts`), added
to each of those seven controllers' guard chains, after `JwtAuthGuard`/
`TenantRoleGuard` so authorization is still checked first. It inspects
`request.params.bookId` (a no-op when absent) and checks for a `BOOK_PURGED`
audit row via the existing `(resource_type, resource_id, occurred_at)`
index — no new table, no new column.

**This is also why the purge-*request* route is deliberately absent from
`AuditInterceptor`'s route table.** `BOOK_PURGED` means "the purge
completed," not "a purge was requested" — auditing it at request time, before
the async job has done anything, would make every read of the book 410
while the book and its artifacts still fully exist. Only the worker writes
this row, once, as the true last step of a purge it actually performed.

## 7. What Phase 10 storage-lifecycle work does *not* include

- **STORAGE_BYTES accounting beyond `BookFile`** — see
  `docs/application/quota-and-usage-model.md` §3.
- **A worker registry / per-attempt storage-class transition trigger tied to
  `ProcessingAttempt`** — that table has no writer in any runtime (P8-6/
  F-26), a separate, larger, already-tracked gap.
- **Tenant-level purge** (`context.md` §19.2's "deletion is tenant-scoped and
  complete" for a whole closed tenant, cascading per-book purge then
  quotas/sessions/credentials/identities/user/tenant). Only book-level purge
  is implemented; the tenant-closure runbook this would sit under does not
  exist yet.
- **A reconciliation/orphan-detection job for the reverse direction**
  (an object in storage with no referencing row — as opposed to the row
  cases this phase handles). Not built; a real, separate follow-on.
