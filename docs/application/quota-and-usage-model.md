# Quota and Usage Model — Phase 10

> **Status:** Phase 10. Describes what is implemented, not what is planned.
> The quota *enforcement* infrastructure (`QuotaService`, `QuotaGuard`) is
> Phase 8 work, already tested and unchanged by this phase. Phase 10 adds the
> two usage-accounting call sites Phase 8 left as schema-only.

---

## 1. The four dimensions — closed, not extensible

`database-schema.md` §7.5's `tenant_quota` table has exactly four limit
columns, and this is the complete list. Phase 8's brief (§44) is explicit:
*"do not invent commercial limits if product policy does not exist."* Phase 10
adds no fifth dimension.

| Dimension | Limit column | Usage metric | Accounting point |
| --- | --- | --- | --- |
| `CONCURRENT_BOOKS` | `concurrent_books_limit` | — (counted live, not accumulated) | `QuotaService.assertCanStartGeneration`, at generation-stage admission |
| `BOOKS_TOTAL` | `books_total_limit` | — (counted live) | `QuotaService.assertCanCreateBook`, at book creation |
| `STORAGE_BYTES` | `storage_bytes_limit` | `TenantUsageCounter` | **Phase 10**: incremented at `BookFile` admission, decremented at purge — see §3 |
| `GPU_MINUTES` | `gpu_minutes_monthly_limit` | `TenantUsageCounter` | **Phase 10**: incremented at TTS chunk completion — see §4 |

`CONCURRENT_BOOKS`/`BOOKS_TOTAL` are **admission checks against a live
count** (`Book` rows in an active-status set, or all non-deleted `Book`
rows), not accumulated counters — there is nothing to "record" for them
beyond the count query itself, and Phase 8 already implemented and tested
both. `STORAGE_BYTES`/`GPU_MINUTES` are genuinely accumulated over a period
via `TenantUsageCounter`, and Phase 8 built the table and the increment
primitive (`QuotaService.recordUsage`) but wired no caller — this phase adds
the callers.

## 2. The two asymmetries, unchanged from Phase 8

**Read fails open, enforcement fails closed.** `GET /users/me/quotas`
degrades to `200 {degraded: true, used: null}` if the usage aggregator is
unreachable — a dashboard should still render. Enforcement
(`assertCanStartGeneration`/`assertCanCreateBook`) never degrades: an
unreachable check refuses the request. Showing a stale number costs nothing;
letting an unmetered book start costs GPU hours.

**No policy row means no limit.** A tenant with no `tenant_quota` row is
**unlimited**, not zero — the absence of a row is the absence of a policy,
never a floor. This is unchanged and load-bearing: Phase 10's new usage
writers (`recordUsage`) never create a `tenant_quota` row, only
`tenant_usage_counter` rows, so accumulating usage for a policy-less tenant
still never becomes a de facto limit.

## 3. STORAGE_BYTES — what is counted and what is not

**Counted (Phase 10, both directions wired and tested):**

- **Increment**: `BooksService.completeUploadSession`
  (`apps/api/src/books/books.service.ts`) calls
  `QuotaService.recordUsage(tenantId, 'STORAGE_BYTES', buffer.byteLength)`
  once a `BookFile` is durably admitted — the dominant, already-instrumented
  size at the point it becomes known.
- **Decrement**: the `purge_book` worker step
  (`apps/worker-cpu/src/processors/maintenance.ts`'s `purgeBookFiles`)
  decrements by each actually-deleted `BookFile.sizeBytes` as it deletes the
  object — skipping any file whose storage key is still referenced by a
  `BookFile` row outside the book being purged (the dedup case,
  `database-schema.md` §27.3: never delete an object another row still
  points at). A fresh counter with no prior increment floors at zero rather
  than going negative.

**Known limitation, not counted:** assembled-audio artifact sizes
(`ChapterAudio`, `Audiobook`, `AudiobookRendition`, and the `AudioChunk`s
transitioned to `EXPIRED` by the retention sweep) are **not** currently
added to or subtracted from `STORAGE_BYTES`. `BookFile` (the uploaded
source) is the largest single-object contributor for most books and was the
one already fully wired for size tracking at write time; extending
accounting to every other artifact class is a real, separate follow-on, not
claimed complete here. See `docs/qa/phase-10-quality-report.md`'s test
results for the exact PASS/NOT TESTED breakdown.

## 4. GPU_MINUTES — wall-clock compute time, not output duration

Recorded directly at TTS chunk completion
(`python/worker-gpu/src/worker_gpu/handlers/generate_tts_chunk.py`, via the
new `writes_tts.record_gpu_minutes_usage`), **not** through
`ProcessingAttempt` lineage — that table has no writer in any runtime today
(QA finding P8-6/F-26, the prior phases' own #1 recommended next item), and
building the worker registry it depends on is a separate, larger effort
explicitly out of this phase's scope (see
`docs/application/identity-and-account-architecture.md` and the Phase 10
report's Known Limitations).

The metric is **wall-clock time spent in the actual synthesis call**
(`time.monotonic()` measured immediately around `synthesize_and_check`),
converted to minutes and rounded — deliberately not `result.duration_ms`,
the *output audio's* duration, which is an unrelated quantity: a slow model
and a fast model can produce the same ten seconds of narration in very
different amounts of real GPU time, and the quota exists to bound compute
cost, not narration length. This is a coarser signal than true per-attempt
GPU device time (no VRAM/utilization telemetry is captured), but it is real,
server-measured usage, not a fabricated or output-derived proxy.

Recorded via a raw SQL upsert (`INSERT ... ON CONFLICT (tenant_id,
period_start, metric) DO UPDATE SET used_value = used_value + EXCLUDED.
used_value`) mirroring `QuotaService.recordUsage`'s exact calendar-month
periods and best-effort failure handling (logged, never fails the job — a
usage-counter write failure is a billing inaccuracy, not a reason to fail
synthesis that already succeeded).

**Not tested in this environment**: this codebase's Python toolchain
requires 3.12, unavailable in the sandbox this phase was implemented in.
The change was syntax-checked (`python -m py_compile`) but never executed.
Classified `NOT TESTED`, not `PASS`, in the Phase 10 report.

## 5. Concurrency and correctness

- **STORAGE_BYTES/GPU_MINUTES increments** use `UPDATE ... SET used_value =
  used_value + n` (an atomic increment, not a read-modify-write), so
  concurrent uploads/completions for the same tenant cannot lose an update
  to a race — this was already true of `QuotaService.recordUsage` and the
  Phase 10 worker-side mirror preserves it.
- **CONCURRENT_BOOKS/BOOKS_TOTAL** are admission checks, not accumulators,
  so there is no increment/decrement to race — a book's contribution to its
  own active-count check is explicitly excluded (`NOT: {id: bookId}`) so
  re-invoking a stage on an already-active book is never refused by its own
  presence in the count.
- **No reservation/release phase.** Both new metrics are pure
  post-hoc accounting (record after the fact), not reserve-then-commit. A
  job that fails or is cancelled before reaching its completion point simply
  never records usage for that attempt — usage is never double-charged, but
  a worker crash between doing the work and recording it means that unit of
  usage is under-reported, not over-reported. This matches the "usage
  under-reported is acceptable, never overcharge" posture `QuotaService`
  already documents for its own best-effort writes.

## 6. Administration — unchanged from Phase 8

`PATCH /admin/tenants/{id}/quotas` (`PLATFORM_ADMIN` only, audited as
`QUOTA_CHANGED`) is Phase 8 work and untouched here. Phase 10 adds no new
admin-facing quota endpoint.
