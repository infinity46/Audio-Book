# Phase 10 Independent Production Audit

> **Auditor role:** Independent senior production auditor, not the Phase 10
> implementer. This is an audit-only artifact. No source file, schema,
> migration, test, or documentation file was modified in the course of this
> audit. Every finding below was independently traced against the actual
> code and, where feasible, actual test execution — not inferred from the
> implementer's self-report (`docs/qa/phase-10-quality-report.md`), which was
> treated as a claim to verify, not evidence.

---

## 1. Executive Summary

**Overall result: FAIL.**

Phase 10 adds real, mostly well-structured functionality on top of Phase 8's
authorization/quota infrastructure: JWT issuance (register/login/refresh/
logout/password-reset), a sessions surface, book restore/purge, a retention
sweep, and the two previously-unwired usage-accounting call sites
(`STORAGE_BYTES`, `GPU_MINUTES`). The frontend integration is genuinely
solid — httpOnly-cookie token storage, no raw fetches, a real (not
decorative) purge-confirmation dialog, no unsafe optimistic deletion. The
database migration is minimal and additive. Every backend/frontend
unit/component test number the self-report claimed (485/485) was
independently reproduced exactly, and this audit additionally ran suites the
self-report marked "not testable" (contract tests, application-layer e2e,
integration tests, and — contrary to the self-report — the full Playwright
e2e suite, all passing) because live Postgres/Redis/MinIO and cached
Playwright browsers turned out to be available in this audit's environment.

However, four **CRITICAL** defects were found, none identified in the
self-report, that individually make production deployment unsafe:

1. **The purge worker's final row-deletion step will hit a live foreign-key
   violation for essentially every real book**, because `OutboxMessage` has
   an `onDelete: Restrict` FK to `Book` that the 17-step purge order never
   clears. Phase 10's flagship "irreversible complete deletion" feature is
   structurally unable to complete against a real database.
2. **Refresh-token rotation's reuse-detection is a check-then-update race**,
   not an atomic claim — two concurrent presentations of the same token (the
   exact scenario reuse-detection exists to catch, e.g. a stolen token used
   while the legitimate client is also refreshing) both succeed silently,
   defeating the theft-detection guarantee.
3. **Both live quota admission checks (`CONCURRENT_BOOKS` at generation
   start, `BOOKS_TOTAL` at book creation) are provable TOCTOU races** — plain
   `count()` reads with no transaction, lock, or DB-level constraint gating
   the subsequent write, and zero concurrency tests exist for either.
4. (Folded into the quota domain below, but load-bearing on its own) the
   `CONCURRENT_BOOKS` race specifically gates GPU-costing generation start —
   the exact "quota can be trivially bypassed for expensive generation"
   scenario this audit's own gate criteria name as a CRITICAL example.

On top of these, twelve **MAJOR** findings span authentication timing
side-channels, a cross-tenant existence-leak in the new purge guard, a
missing quota guard on one expensive route, non-atomic storage-usage
accounting that can silently lose or double-charge usage, a Python
transaction-poisoning risk in the GPU-usage writer, an unguarded
restore-vs-purge race that lets the API report "restored" while the book is
in fact being permanently destroyed, and two frontend error-handling gaps.

**Production risk: high.** The identity/session and quota/usage-accounting
domains — precisely Phase 10's stated scope — contain the most severe
findings. None of the four CRITICAL issues were caught by the existing test
suite, because none of them require anything the suite doesn't already claim
to cover (idempotency, reuse-detection, quota enforcement) — they are gaps
in what the tests actually exercise (sequential-only reuse, mocked
in-memory stores with no FK enforcement, no concurrency harness), not gaps
in test *topic* coverage. This is the central lesson of this audit: passing
tests were not equivalent to correct behavior in every case examined.

---

## 2. Scope

Independently audited, by seven parallel investigative passes plus direct
review by this auditor:

- Identity/auth/session issuance (`apps/api/src/auth/**`, `users/**`)
- Ownership/authorization/BOLA (`common/tenant.ts`, `common/guards/**`,
  `admin/**`, `platform/**`, guard-chain wiring across all book-scoped
  controllers)
- Quota and usage accounting, and its concurrency safety
  (`common/quota.service.ts`, `common/guards/quota.guard.ts`,
  `books.service.ts`, `worker-cpu/processors/maintenance.ts`,
  `worker-gpu/repo/writes_tts.py`, `worker-gpu/handlers/generate_tts_chunk.py`)
- Storage lifecycle, deletion, purge, retention, events, workers
  (`worker-cpu/processors/maintenance.ts`, `worker-cpu/retention-sweeper.ts`,
  `common/guards/book-purge.guard.ts`, `common/audit.service.ts`,
  `common/interceptors/audit.interceptor.ts`)
- Database migration and schema diff (`prisma/migrations/0005_*`,
  `prisma/schema.prisma`), API/contract conformance
  (`packages/contracts/schemas/*.json`), error handling, rate limiting
- Frontend Phase 9/10 integration (`apps/web/src/**`, `apps/web/e2e/**`)
- Actual execution of every test suite the self-report referenced, plus
  suites it marked unrunnable

Out of scope (matching Phase 10's own stated boundaries, confirmed absent
rather than assumed): MFA enrollment, tenant-level purge, OAuth/OIDC,
`STORAGE_BYTES` accounting beyond `BookFile`, worker-registry/
`ProcessingAttempt` lineage, reverse-orphan (object-with-no-row) storage
reconciliation.

---

## 3. Architecture Baseline

Authoritative documents used to establish requirements (implementation is
not authoritative where it conflicts with these):

- `docs/architecture/api-specification.md` §16.1 (Authentication), §16.2
  (Users/sessions), §16.6 (deletion/restore/purge), §8.1 (error envelope)
- `docs/architecture/database-schema.md` §27 (deletion, retention, purge —
  the exact 17-step order and the "never deletes a stored object another row
  still references" / RESTRICT-satisfaction rules)
- `docs/architecture/event-contracts.md` (36-event closed catalogue, outbox
  envelope/naming conventions, promised outbox retention sweep)
- `docs/architecture/context.md` §3.2.2/§3.2.3/§19.1/§19.2 (event naming,
  quota read/enforcement asymmetry, tenant-scoped-and-complete deletion)
- `docs/application/identity-and-account-architecture.md`,
  `quota-and-usage-model.md`, `storage-lifecycle.md` (Phase 10's own
  as-built documentation, treated as claims to verify)
- `docs/qa/phase-8-report.md` (baseline for what ownership/quota/audit
  infrastructure Phase 10 was built on top of, and must not regress)

---

## 4. Implementation Reviewed

New: `apps/api/src/auth/**`, `apps/api/src/users/**`,
`apps/api/src/admin/**`, `apps/api/src/platform/**`,
`apps/api/src/events/**`, `apps/api/src/jobs/**`, `apps/api/src/progress/**`,
`apps/api/src/common/{audit.service.ts,quota.service.ts,prisma-error.ts}`,
`apps/api/src/common/guards/{book-purge,platform-admin,quota}.guard.ts`,
`apps/api/src/common/interceptors/audit.interceptor.ts`,
`apps/worker-cpu/src/retention-sweeper.ts`,
`apps/worker-cpu/src/cancellation-gate.ts`, `apps/web/**` (new Next.js app),
`packages/contracts/schemas/{register,login,mfa-exchange,refresh-token,
password-reset-request,password-reset-confirm,restore-book,purge-book,
update-book,update-current-user,update-tenant-quotas,cancel-job,
replay-job}.schema.json`, `prisma/migrations/0005_phase10_auth_and_deletion`.

Modified: `apps/api/src/books/{books.controller,books.service}.ts`,
`apps/worker-cpu/src/processors/maintenance.ts` (rewritten),
`apps/api/src/common/{tenant.ts,rate-limit/buckets.ts,
pipes/ajv-validation.pipe.ts,filters/all-exceptions.filter.ts}`,
`packages/config/src/{index.ts,schemas.ts}`, `prisma/schema.prisma`
(additive index changes plus two enum values), `python/worker-gpu/**`.

No scope creep found: no payments/billing/subscription code, no unrelated
architecture rewrites. `pnpm-lock.yaml`'s large diff is dependency-lock churn
from legitimate new packages (Argon2, JWT libs), not evidence of scope
creep on its own — not separately re-audited line by line, which is a
disclosed limitation of this report, not a finding.

---

## 5. Security Findings

## [CRITICAL] Refresh-token rotation reuse-detection is a check-then-update race

**Category:** Security
**Location:** `apps/api/src/auth/auth.service.ts:296-361` (`refresh()`)
**Requirement:** `api-specification.md` §16.1: presenting an already-rotated
refresh token must be detected as reuse, revoking the whole token family —
this is the mechanism that distinguishes a stolen-and-replayed token from
normal client behavior.
**Observed:** `refresh()` reads the token row with a plain `findUnique`
outside any transaction, checks `rotatedAt` in application code, and only
then — in a separate transaction — performs an unconditional
`update({ where: { id: row.id }, data: { rotatedAt: now, ... } })`, not a
conditional `UPDATE ... WHERE rotated_at IS NULL`. No DB-level uniqueness or
locking guards this.
**Why it matters:** Two concurrent presentations of the same refresh token —
an attacker replaying a stolen token while the legitimate client also
refreshes — both pass the `rotatedAt` check and both succeed. Reuse is never
detected, the family is never revoked, and no security audit record is
written. This is the exact threat the mechanism exists to catch.
**Evidence:** Full trace of `refresh()`; `auth.service.test.ts`'s reuse test
(line ~367) only exercises **sequential** `await`ed calls, never concurrent
ones — the race is untested, not merely unguarded.
**Expected behavior:** The rotation claim must be one atomic conditional
update (e.g. `UPDATE ... WHERE id = $id AND rotated_at IS NULL`, checking
affected-row count), with reuse-detection triggered from a zero-row result.
**Recommended remediation:** Replace the read-then-write with a single
atomic conditional update that claims the token before any new token is
issued.

## [MAJOR] `BookPurgeGuard` is tenant-blind, creating a cross-tenant purge-existence oracle

**Category:** Security (IDOR/BOLA — information disclosure)
**Location:** `apps/api/src/common/guards/book-purge.guard.ts:37-42`; runs
before the service-layer `assertTenantOwnership` check in every one of the
seven controllers it's wired into.
**Requirement:** This codebase's own stated invariant (`tenant.ts`): "a 403
would disclose that the resource exists for a tenant the caller can't see
into" — cross-tenant access must always read as a uniform 404.
**Observed:** The guard queries `audit_log` by `resourceType/resourceId/
action` only, with no `tenantId` filter (the column exists, unused here),
and runs before ownership is established. Any authenticated user who knows
or guesses a foreign tenant's `bookId` gets a distinguishable
`410 RESOURCE_PURGED` vs. ordinary `404`, leaking that a specific
cross-tenant resource existed and was purged.
**Why it matters:** Narrow (requires already possessing a foreign bookId)
but a genuine, avoidable violation of the codebase's own consistently-applied
no-existence-leak rule.
**Evidence:** Guard query shape; guard-chain ordering confirmed across all 7
controllers (see §7 table); `books.service.ts` comment confirms the guard
runs before `assertTenantOwnership` would.
**Expected behavior:** A cross-tenant `bookId`, purged or not, should read
as a uniform 404.
**Recommended remediation:** Scope the guard's audit_log lookup by the
caller's `tenantId` as well (the column and an adjacent index already
exist).

## [MAJOR] `QuotaGuard` missing from `VoiceController` — one expensive route has no admission check

**Category:** Security / Architecture
**Location:** `apps/api/src/voice/voice.controller.ts:68`; route
`POST books/:bookId/casting/narrator-fallback`.
**Requirement:** `quota.guard.ts`'s own documented design principle: a
per-route decorator someone forgets to add "leaves that route with no quota
check at all, which is the one failure mode an admission control must not
have." This codebase classifies `casting` as an `EXPENSIVE_SEGMENTS` route.
**Observed:** `QuotaGuard` is present in the `@UseGuards(...)` chain of
Books/Director/Analysis/Assembly/Tts controllers but absent from
`VoiceController`'s — the exact failure mode the guard's own docstring warns
against.
**Why it matters:** A tenant at its `CONCURRENT_BOOKS` limit can still
trigger narrator-fallback casting (pipeline-starting work) with zero quota
check.
**Evidence:** `@UseGuards` diff across all six book-scoped controllers;
`QuotaGuard` present in 5/6, absent only from `voice.controller.ts`.
**Expected behavior:** `QuotaGuard` should be present like the other five.
**Recommended remediation:** Add `QuotaGuard` to `VoiceController`'s guard
chain; add a guard-level test (see §17) so a future omission is caught by
CI rather than by manual audit.

## [MAJOR] Registration enumeration protection matches hashing cost only, not full request cost

**Category:** Security (timing side-channel)
**Location:** `apps/api/src/auth/auth.service.ts:119-198`
**Requirement:** A duplicate-email registration must be indistinguishable
from a genuine one — the self-report explicitly claims timing parity.
**Observed:** The duplicate path does one lookup plus one Argon2 hash. A
genuine new registration additionally runs a transaction with a tenant
create, user create, credential create, an outbox write, and an audit-log
write — five extra DB writes the duplicate path never performs.
**Why it matters:** Under real Postgres latency this multi-write
transaction is a measurable, averageable timing signal distinguishing
"email already registered" from "new registration" — precisely what
enumeration protection is meant to prevent.
**Evidence:** Direct comparison of both code branches; the implementation's
own docstring only claims hashing-cost parity, not I/O parity.
**Expected behavior:** Equivalent-cost work on both branches, or a
restructuring that decouples synchronous response time from write count.
**Recommended remediation:** Pad the duplicate path with comparable-shape
dummy DB work, or move registration to an async-decoupled response model.

## [MAJOR] Login timing side-channel: failed-attempt bookkeeping runs only on the known-account branch

**Category:** Security (timing side-channel)
**Location:** `apps/api/src/auth/auth.service.ts:228-245`
**Requirement:** "Identical shape and timing for an unknown account and a
wrong password" (spec §14.11).
**Observed:** The unknown-account branch does one dummy Argon2 verify then
throws. The known-account-wrong-password branch does the same verify *plus*
an additional DB write (`recordFailedAttempt`) before throwing.
**Why it matters:** A real, structural timing asymmetry between two paths
documented and tested as "identical" — smaller than the registration gap
above, but present and untested by the existing suite (which only asserts
both branches throw the same error type, never compares timing/work).
**Evidence:** Code path comparison; `auth.service.test.ts`'s "unknown email
fails exactly like a wrong password" test never exercises the extra write.
**Expected behavior:** Equivalent-cost work on both branches.
**Recommended remediation:** Make the failed-attempt increment
non-blocking relative to the response, or add an equivalent dummy write on
the unknown-account path.

## [MINOR] Account lockout is an unmitigated per-account DoS surface

**Category:** Security
**Location:** `apps/api/src/auth/auth.service.ts:526-537`
**Observed:** Lockout is keyed purely by `userId`/email with no IP or
CAPTCHA signal. Any caller who knows a victim's email can lock that account
for `AUTH_LOGIN_LOCKOUT_SECONDS` (default 900s) repeatedly, indefinitely.
**Why it matters:** Trivial, low-cost griefing vector against any known
address.
**Recommended remediation:** Accepted-risk sign-off, or add CAPTCHA/IP
correlation after N failures — a product decision, not a required fix.

## [MINOR] Spec's "progressive delay" is not implemented — only a hard threshold lockout

**Category:** Security / Contract conformance
**Location:** `apps/api/src/auth/auth.service.ts:526-537`; spec text
`api-specification.md:1637-1638`.
**Observed:** Only a hard lockout exists; no growing per-attempt delay below
the threshold, despite the spec's "progressive delay **and** lockout"
wording.
**Recommended remediation:** Add an increasing artificial delay proportional
to failed-attempt count, in addition to the existing hard lockout.

## [MINOR] `ACCOUNT_LOCKED` response omits the spec-mandated `Retry-After` header

**Category:** API / Security
**Location:** `apps/api/src/auth/auth.service.ts:233-239`;
`apps/api/src/common/filters/all-exceptions.filter.ts`.
**Requirement:** Spec: "`ACCOUNT_LOCKED` (`429`) with `Retry-After`."
**Observed:** Only the generic per-bucket `RateLimitGuard` 429 sets
`Retry-After`; the account-lockout 429 (a different code path,
`QuotaExceededError` thrown from `login()`) never does, despite
`lockedUntil` being known at throw time.
**Recommended remediation:** Compute `Retry-After` from `lockedUntil` and
thread it to the response, or extend the shared error filter to apply it
generically for any error carrying a retry hint.

## [MINOR] Sessions `DELETE` returns 204-always, not the spec-documented 404 for a foreign/absent session

**Category:** Security / Contract conformance
**Location:** `apps/api/src/users/users.controller.ts:60-67`;
`users.service.ts:155-159`.
**Requirement:** Spec: "a session belonging to another principal is 404."
**Observed:** The controller hard-codes 204 for every outcome; the service
silently no-ops for both foreign and missing sessions.
**Why it matters:** The no-leak security property is actually preserved
(foreign and missing sessions are indistinguishable), so this is not an
authorization bypass — but it's a genuine contract deviation, and
inconsistent with this codebase's own `assertTenantOwnership` idiom
elsewhere (404, not 204, for a not-found/foreign resource).
**Recommended remediation:** A spec-vs-implementation reconciliation
decision (not a unilateral code change) — either the spec should be amended
to match the arguably-safer 204-always behavior, or the implementation
should throw 404 to match the documented contract.

## [OBSERVATION] The documented BROWSER cookie-login path is unreachable in the actual product

**Category:** Architecture / Security-adjacent
**Location:** `apps/api/src/auth/auth.controller.ts:167-195`;
`apps/web/src/lib/server/auth-client.ts:60-66`.
**Observed:** `JwtAuthGuard` is Bearer-only with no cookie fallback, so a
pure BROWSER/cookie client as specified could never obtain a bearer token
to call any protected route including `/auth/logout`. In practice the real
frontend always uses `client_type: "API"` server-side and never exercises
this path. `/auth/logout` correspondingly has no CSRF check (consistent with
never being cookie-authenticated in practice), while the self-report's claim
that CSRF applies to both cookie-authenticated refresh *and* logout is not
accurate for logout as currently reachable.
**Recommended remediation:** Product decision: retire the unreachable
BROWSER path, or add the missing piece (e.g. a short-lived access-token
cookie or `/auth/session` endpoint) and CSRF-protect logout accordingly.

**CSRF on `/auth/refresh`:** implementation exists (`assertCsrf`) and is
genuinely, honestly marked NOT TESTED by the self-report — confirmed no test
anywhere exercises it. Not re-classified as a defect since it's disclosed,
but remains unverified.

---

## 6. Identity Findings

Summarized here; full detail in §5 (most identity findings are also
security findings and are not duplicated).

**Verified TRUE, with evidence:** enumeration protection creates no
duplicate row and returns identical 201 shape; real Argon2id with
dummy-hash comparison for unknown accounts (tested against real Argon2
calls, not mocked); refresh/reset tokens stored only as SHA-256 hashes,
never plaintext; `sid` is decoded server-side from the already-verified
bearer token with no client-supplied-session-id path; `JwtAuthGuard` is
byte-identical to pre-Phase-10 (confirmed via diff) and still reads only
`sub`/`tenant_id`/`roles`/`scopes`; `AUTH_JWT_PRIVATE_KEY` absence fails
closed with `AUTH_ISSUANCE_NOT_CONFIGURED` rather than crashing or signing
insecurely; the `auth` rate-limit bucket is defined and actually applied via
`@UseGuards(RateLimitGuard)` on every auth route; no MFA enrollment endpoint
exists anywhere in the repo; secrets never appear in audit rows or logs;
sequential refresh-token reuse correctly revokes the whole family (the
concurrent case is the CRITICAL finding in §5); password-reset confirm
correctly revokes every session/refresh token for the principal.

---

## 7. Ownership Findings

**Guard-chain audit — `BookPurgeGuard` presence and position across all
seven claimed controllers (independently re-verified):**

| # | Controller | Guard chain | BookPurgeGuard | Position |
|---|---|---|---|---|
| 1 | BooksController | JwtAuthGuard, TenantRoleGuard, RateLimitGuard, QuotaGuard, BookPurgeGuard | Yes | Last |
| 2 | DirectorController | same shape | Yes | Last |
| 3 | AnalysisController | same shape | Yes | Last |
| 4 | AssemblyController | same shape | Yes | Last |
| 5 | TtsController | same shape | Yes | Last |
| 6 | VoiceController | JwtAuthGuard, TenantRoleGuard, RateLimitGuard, **no QuotaGuard**, BookPurgeGuard | Yes | Last |
| 7 | ProgressController | JwtAuthGuard, TenantRoleGuard, RateLimitGuard, BookPurgeGuard | Yes | Last |

All seven claimed controllers verified present; `JobsController` correctly
excluded (no `bookId` param); no other book-scoped controller found
missing. The one gap in this table (VoiceController's missing `QuotaGuard`)
is reported in §5.

**Verified TRUE:** `assertTenantOwnership` unchanged by Phase 10, still
404-only for cross-tenant references; `requireRole` correctly throws 403
(not 404) for a non-owner tenant member, called after ownership is
established for restore/purge; `TenantRoleGuard` refuses `PLATFORM_ADMIN` on
content routes and `PlatformAdminGuard` enforces the reverse; admin surface
(`admin/*`) returns only counts/metadata, never book titles, every read
audited as `ADMIN_CROSS_TENANT_READ`; sessions `DELETE` is scoped by
`{id: sessionId, userId: principal.sub}` at the query level, not a
fetch-then-check; a general BOLA sweep of new-file Prisma queries found
every book/job/session lookup correctly tenant/user-scoped except the one
admin-only cross-tenant path, which is itself gated behind
`PlatformAdminGuard`.

**Not verified TRUE — see §5:** `BookPurgeGuard`'s tenant-blind existence
oracle.

---

## 8. Quota Findings

## [CRITICAL] `CONCURRENT_BOOKS` admission is structurally decoupled from the state transition it gates

**Category:** Quota
**Location:** `apps/api/src/common/guards/quota.guard.ts:38-54`;
`apps/api/src/common/quota.service.ts:52-79` (`assertCanStartGeneration`)
**Observed:** The check runs in a Nest Guard — a separate request phase from
whatever handler later changes book/job status — as a bare `count()` with no
lock, evaluated and discarded before the controller method (and its own
transaction, if any) begins.
**Why it matters:** Two simultaneous "start generation" requests for two
different books both evaluate the guard before either has caused the
other's book to enter an active-status state, so both are admitted even if
that exceeds the tenant's concurrency cap. This directly matches this
audit's own CRITICAL example: "quota can be trivially bypassed for
expensive generation" — this gates real GPU spend.
**Evidence:** Guard body; no lock/transaction anywhere spans check +
transition; zero concurrency tests found (`grep` for "concurrent"/"race"/
"parallel"/`Promise.all` across quota test files returns nothing).
**Recommended remediation:** A tenant-scoped lock (e.g.
`pg_advisory_xact_lock`) or serializable transaction held across
check-and-transition, or a DB-level constraint (partial unique index /
trigger) capping active-status rows per tenant, since a Guard cannot hold a
transaction open across the handler.

## [MAJOR] `BOOKS_TOTAL` admission at book creation is the same class of TOCTOU race

**Category:** Quota
**Location:** `apps/api/src/books/books.service.ts:172-197` (`createBook`);
`quota.service.ts:82-98` (`assertCanCreateBook`)
**Observed:** `count()` then a separate, unguarded `book.create()` — no
transaction, lock, or DB-level backstop.
**Why it matters:** Concurrent `POST /books` requests one below the limit
all pass the check and all create, exceeding `books_total_limit` by however
many requests race. Lower severity than the generation-start race since the
resource abused (extra `Book` rows) doesn't directly cost GPU spend, but it
is an equally provable, equally unguarded quota bypass.
**Recommended remediation:** Same pattern as above — serializable
transaction or advisory lock around count+create.

**Both races are NOT PROVEN safe** by any existing test — this audit
classifies them as findings rather than "not proven" precisely because the
absence of any locking primitive in the code makes the race provable by
inspection, not merely untested.

**Verified TRUE:** "No policy row → unlimited" correctly implemented and
tested (`!quota` short-circuits before any count query, with an explicit
test asserting `book.count` was never called); the `NOT: {id: bookId}`
self-exclusion for a book's own active-status contribution is real and
tested; `recordUsage`/`record_gpu_minutes_usage` failures never propagate to
the caller (explicitly tested on the Node side); read-fails-open vs.
enforcement-fails-closed asymmetry is structurally consistent with
`quota.service.ts`'s own documented contract.

---

## 9. Usage Findings

## [MAJOR] `STORAGE_BYTES` decrement is not transactional with the `BookFile` row deletion it accounts for

**Category:** Usage / Reliability
**Location:** `apps/worker-cpu/src/processors/maintenance.ts:381-412`
(`purgeBookFiles`)
**Observed:** `deleteMany` on `BookFile` rows happens first; the counter
decrement is a separate, non-transactional call afterward.
**Why it matters:** A crash/redelivery between the two leaves the retry's
`findMany` returning zero rows (already deleted) — `freedBytes` computes to
0 and the decrement is permanently skipped. This is idempotent against
*double*-decrementing but not safe against *losing* the decrement, which is
the opposite of what "idempotent" is being used to claim. The tenant's
counter is stuck over-counting those bytes forever, with no recovery path
anywhere in the codebase.
**Evidence:** Full function read; no `$transaction` wraps both operations;
the existing idempotency test only redelivers *after* a fully successful
run, never mid-way.
**Recommended remediation:** Wrap the row deletion and the counter decrement
in one transaction, or persist `freedBytes` on the job row before deleting
rows so a retry can recompute/replay it.

## [MAJOR] "Floors at zero" claim is true only for a brand-new counter row, not an existing one

**Category:** Usage
**Location:** `apps/worker-cpu/src/processors/maintenance.ts:414-439`
(`recordStorageBytesDelta`)
**Observed:** The `create` branch floors correctly
(`deltaBytes > 0n ? deltaBytes : 0n`); the `update` branch is a plain
`increment: deltaBytes` with no floor.
**Why it matters:** A tenant whose counter row already exists but whose
decrement exceeds its current `used_value` (e.g. a book uploaded in an
earlier period, purged in a later one) drives the counter negative. Only the
fresh-row case is tested; the existing-row test only exercises a decrement
smaller than the current balance.
**Recommended remediation:** Apply a `GREATEST(0, used_value - n)`-equivalent
floor in the update branch too (requires raw SQL, since Prisma's
`decrement` can't express a floor).

## [MAJOR] Concurrent `completeUploadSession` calls can double-charge `STORAGE_BYTES` and create duplicate `BookFile` rows

**Category:** Quota / Usage
**Location:** `apps/api/src/books/books.service.ts:610-768`
**Observed:** `session.status` is read once at entry and not persisted as
`'ADMITTED'` until after the transaction commits, after job enqueue, and
after `recordUsage`. The duplicate content-hash check is a plain
non-transactional `findFirst`.
**Why it matters:** Two concurrent completion calls for the same upload
session (a realistic client-retry-after-timeout scenario) both pass both
checks before either commits, both create separate `BookFile` rows, and
both call `recordUsage` for the same bytes — directly contradicting the
"usage is never double-charged" claim.
**Recommended remediation:** Use the session store's update as an atomic
compare-and-swap "claim" before starting work, or bring the duplicate-hash
check into the same transaction with an appropriate lock/constraint.

## [MAJOR] Python `record_gpu_minutes_usage`'s bare `except` can silently poison the transaction it shares with the successful synthesis result

**Category:** Reliability
**Location:** `python/worker-gpu/src/worker_gpu/repo/writes_tts.py:461-504`,
called from `handlers/generate_tts_chunk.py:222-227`
**Observed:** The GPU-usage upsert runs inside the same session/transaction
as `insert_audio_chunk`, `mark_job_succeeded`, and `write_tts_event`,
wrapped only in a local `try/except` that logs and swallows.
**Why it matters:** Under Postgres, once any statement inside a transaction
errors, the whole transaction is aborted — every subsequent statement,
including the final commit, fails until rollback. Swallowing the error
locally does not save the transaction: if the upsert genuinely throws at the
DB level (transient connection issue, deadlock), the subsequent event write
and the commit itself fail, unwinding the already-successful
`insert_audio_chunk`/`mark_job_succeeded` too. This is the opposite of the
intended "best-effort, never fails the job" posture, and is asymmetric with
the Node side, where `recordUsage` correctly runs as a standalone call
*after* the main transaction commits.
**Recommended remediation:** Move the GPU-usage write to its own
session/transaction after the main persist commits, or wrap it in a
`SAVEPOINT` so a local failure can be rolled back without poisoning the
parent transaction.

**Verified TRUE:** the GPU_MINUTES upsert SQL is fully parameterized (no
injection risk) and genuinely atomic (`ON CONFLICT ... DO UPDATE SET
used_value = used_value + EXCLUDED.used_value`, not read-then-write); the
`ON CONFLICT` target matches a real unique index in the schema/migration; no
double-counting on TTS retry (the usage call only fires inside the
persist transaction, after a pre-synthesis lineage check that short-circuits
already-completed chunks) — a crash before that transaction commits causes
under-reporting, never over-reporting, consistent with the documented
trade-off (modulo the transaction-poisoning risk above).

---

## 10. Storage Findings

Covered jointly with deletion/retention in §11 below, as the two domains
share the same evidence base (the purge worker).

---

## 11. Deletion & Retention Findings

## [CRITICAL] Purge step 16 (`book.deleteMany`) will violate an undocumented FK RESTRICT for essentially every real book

**Category:** Storage / Lifecycle / Reliability
**Location:** `apps/worker-cpu/src/processors/maintenance.ts:179-183`
(step 16); `prisma/schema.prisma` — `OutboxMessage.book` relation,
`onDelete: Restrict`.
**Requirement:** §27.4: "deletes strictly bottom-up, so every RESTRICT is
satisfied at each step." `event-contracts.md` additionally promises
published outbox rows are deleted after a bounded window.
**Observed:** `OutboxMessage.bookId` carries a real `Restrict` FK to `Book`.
Every book-scoped event (`book.uploaded`, ingestion, assembly, analysis,
jobs) is written via `writeOutboxMessage(tx, {..., bookId, ...})`. The
outbox publisher only ever updates `status`/`publishedAt`/etc. — it never
deletes or nulls the row. No file anywhere in the repo calls
`outboxMessage.deleteMany`. The 17-step purge order never touches
`outbox_message`. Consequently `book.deleteMany` at step 16 raises a live
FK violation for any book that ever produced even one outbox event — which
is essentially every non-trivial book.
**Why it matters:** Under the real database (not the in-memory test double
used by `maintenance-purge.test.ts`, which has no `outboxMessage` table and
so cannot catch this), the purge throws at its very last row-deleting step,
every time. The job is marked `FAILED` and retried per BullMQ policy, but
every retry hits the identical unresolved FK — **the purge can never
succeed without manual out-of-band intervention.** Phase 10's flagship
"irreversible complete deletion" capability, the thing §16.6.3 and the
entire storage-lifecycle document exist to build, does not function against
a real database. This also means the promised general outbox-retention
sweep (§19.6, "PUBLISHED rows deleted after a bounded window") was never
built at all, not even outside the purge path.
**Evidence:** Repo-wide grep confirms zero `outboxMessage.deleteMany`/
nullification call sites; schema confirms the `Restrict` FK; step order
confirmed against §27.4 line-by-line (see table below) with this being the
sole non-conforming step.
**Expected behavior:** The book row must not be blocked by orphaned outbox
rows at purge time.
**Recommended remediation:** Add an explicit purge sub-step deleting (or
nulling `book_id` on) `outbox_message` rows for the book immediately before
step 16, and separately build the generic outbox-retention sweep the event
contract already promises — tested against a schema that actually enforces
the FK, not an in-memory mock.

**17-step purge order — independently re-verified against `database-schema.md`
§27.4:**

| # | Spec requirement | Actual code | Match |
|---|---|---|---|
| 1–15, 17 | (see database-schema.md §27.4) | Confirmed line-for-line in `maintenance.ts` | ✅ |
| 16 | `book_counter, book` | `book.deleteMany` — blocked by unhandled `OutboxMessage` FK | ⚠️ CRITICAL, see above |

Object-before-row ordering was independently confirmed at every
artifact-bearing step; the dedup-safety check (skip object delete if another
`BookFile` row outside the book still references the key) is real and
covered by an explicit two-book-shared-key test; the purge job's own
`ProcessingJob` row is correctly excluded from its own deletion step;
failure anywhere correctly marks the job `FAILED`/retryable and re-throws;
step 17's `audit_log: BOOK_PURGED` write is confirmed as the sole, final,
worker-only signature `BookPurgeGuard` checks.

## [MAJOR] Concurrent restore-vs-purge is unguarded — the API can report "restored" while the book is actually being destroyed

**Category:** Lifecycle / Reliability
**Location:** `apps/api/src/books/books.service.ts` (`restoreBook`,
`purgeBook`); `apps/worker-cpu/src/processors/maintenance.ts:99-121`
**Observed:** `purgeBook` checks preconditions only at dispatch time.
`runPurgeBook` never re-reads `book.deletedAt` before or during execution —
it only short-circuits on the job's own `SUCCEEDED` status. `restoreBook`
never checks for an in-flight `cleanup_artifacts` job for the book.
**Why it matters:** Sequence: owner triggers purge (job `CREATED`) → worker
begins executing → owner concurrently calls restore → `restoreBook` still
finds `deletedAt` set (purge hasn't reached its terminal step) and clears
it, returning `200 restored` → the worker, unaware, finishes deleting
everything anyway. The API told the caller their book was safely restored
while it was in fact permanently destroyed seconds later — a direct
violation of restore's documented reversibility guarantee, with no error
surfaced to the caller at any point.
**Recommended remediation:** `restoreBook` should reject (409) if an active
`cleanup_artifacts` job exists for the book, and/or `runPurgeBook` should
re-verify `deletedAt` is still set before/during execution and abort
cleanly if cleared.

## [MINOR] `RetentionSweeper.stop()` is synchronous and doesn't await its in-flight sweep, unlike its sibling `ProcessingJobSweeper`

**Category:** Reliability
**Location:** `apps/worker-cpu/src/retention-sweeper.ts:39-42` vs.
`processing-job-sweeper.ts:137`; `apps/worker-cpu/src/main.ts:254-258`
**Observed:** Shutdown awaits `processingJobSweeper.stop()` but calls
`retentionSweeper.stop()` synchronously before tearing down
Prisma/Redis — a mid-sweep query can race the teardown, producing spurious
(harmless, caught) error logs on every deploy/restart.
**Recommended remediation:** Make `stop()` async and await the in-flight
sweep, mirroring the sibling sweeper.

## [OBSERVATION] No test exercises true worker-crash-mid-purge resume

Existing tests cover "already `SUCCEEDED` → no-op" and "step throws → job
`FAILED`," but not "crashed after steps 1–8, retried, must skip empty tables
and finish 9–17." The idempotency design is sound by inspection, but this
specific scenario — the one most likely in a real BullMQ redelivery — is
untested end-to-end.

**Verified TRUE (in addition to the above):** retention sweep eligibility
conditions match the documented rules exactly for both sub-responsibilities
(orphaned `REJECTED` uploads past TTL; superseded chunks only when the book
is `COMPLETED` with a current audiobook set, past the retention window),
each confirmed by dedicated positive and negative tests; both transitions
clear bytes via `storage_class: EXPIRED` and never delete rows; `restoreBook`
clears only `deletedAt`, never `status`; purge dispatch correctly enforces
`TENANT_OWNER`, `confirm_book_id` match, soft-deleted precondition, active-jobs
precondition (implemented as a superset of the spec's required set, i.e.
stricter, not looser), and `Idempotency-Key`; the purge-request route is
deliberately absent from `AuditInterceptor`'s table so `BOOK_PURGED` is only
ever written once, by the worker, as the true terminal step; `user.registered`
and `auth.password_reset_requested` are genuinely absent from
`event-contracts.md`'s 36-event catalogue (a real, disclosed gap, not a
Phase 10 invention) and have no consumer anywhere in the repo; no
reverse-orphan (object-with-no-row) reconciliation job exists anywhere,
confirmed by repo-wide search, matching the claimed absence.

---

## 12. Event & Worker Findings

See §11 for the outbox/FK finding (the most significant event-related
defect) and the retention-sweeper shutdown finding. Outbox envelope
conventions for the two new event types are correctly followed; no direct
queue bypass was found; cooperative cancellation (`cancellation-gate.ts`,
Python `cancellation.py`) was reviewed only incidentally — not a Phase 10
focus area and no defect surfaced.

---

## 13. Database Findings

Migration `0005_phase10_auth_and_deletion` reviewed line-by-line: exactly
two `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statements, nothing else,
matching the self-report precisely. No same-transaction hazard (nothing in
the migration uses the new values within its own transaction; Postgres is
pinned at 16.6 in `docker-compose.yml`, well past the version where
`ADD VALUE` itself became transaction-safe). `IF NOT EXISTS` present on
both, safe to re-apply. `schema.prisma`'s diff is otherwise limited to
additive `@@index` additions — no column/type/nullability/default change
anywhere. No new tables; the guard's audit_log-based approach in place of a
planned `PurgedBookTombstone` table is a reasonable, verified-working
substitution.

No CRITICAL or MAJOR database-schema findings beyond the `OutboxMessage` FK
issue already reported in §11 (that finding is a purge-logic gap, not a
migration/schema defect — the FK itself is correct and intentional; the
purge code simply never satisfies it).

---

## 14. API Findings

Contract schemas for all eight new auth/deletion endpoints (`register`,
`login`, `mfa-exchange`, `refresh-token`, `password-reset-request`,
`password-reset-confirm`, `restore-book`, `purge-book`) were compared
field-for-field against `api-specification.md` §16.1/§16.6 and match exactly
— correct required-ness, types, and `additionalProperties: false`. Error
envelope (`all-exceptions.filter.ts`, `prisma-error.ts`) never leaks stack
traces, SQL, or Prisma internals; `P2002` (unique violation) is correctly
caught and mapped in the one place it matters for Phase 10
(`auth.service.ts`'s duplicate-registration race). The AJV empty-body
normalization does not bypass `required`-field validation. No undocumented
endpoint or scope-creep route was found. MFA enrollment is confirmed
genuinely absent, matching the spec's "must not invent" instruction.

Findings: the `Retry-After` header gap and the sessions-DELETE
404-vs-204 contract deviation, both reported in §5.

---

## 15. Frontend Findings

## [MAJOR] Silent failure on session-revoke error

**Category:** Frontend / Error handling
**Location:** `apps/web/src/components/settings/SettingsView.tsx:273-284`
**Observed:** The revoke-session mutation has no `onError` handler at all —
a failed revoke (already-revoked race, 403, network error) gives the user
zero feedback; the button simply stops spinning.
**Why it matters:** A user revoking a suspicious session and getting silence
may believe it worked when it didn't — significant specifically because
this is a security-relevant action.
**Recommended remediation:** Add an `onError` toast, consistent with every
other mutation-with-feedback in this codebase.

## [MAJOR] Restore/purge errors are shown as one generic message, not the code-specific presentation this codebase already has

**Category:** Frontend / Error handling
**Location:** `apps/web/src/components/project/ProjectCard.tsx:145,157`
**Observed:** Both `onError` handlers use a single hardcoded toast string
regardless of `ApiError.code`. `FORBIDDEN`, `BOOK_HAS_ACTIVE_JOBS` (409),
`RESOURCE_GONE` (410), and `VALIDATION_FAILED` (422, confirm-id mismatch)
all render identically, even though this codebase's own `describeError`
utility already defines distinct, actionable presentations for each of
these — used correctly by every other mutation in the app except this one.
**Why it matters:** A user hitting "book still has active jobs" gets no
hint to cancel jobs first; the app's own error-handling contract exists
specifically to prevent this and isn't applied here.
**Recommended remediation:** Route the mutation's error through
`describeError()` before toasting, matching the established pattern.

## [MINOR] No e2e mock endpoint for the sessions feature

**Category:** Frontend / Test coverage
**Location:** `apps/web/e2e/mock-api/server.ts`
**Observed:** No handler for `GET`/`DELETE /api/v1/users/me/sessions`; no
e2e spec exercises the Settings sessions panel. Consistent with the
self-report's own disclosed "e2e not executed" hedge rather than a
contradicted claim, but the gap persists even now that this audit confirmed
the e2e suite does run in environments with cached Playwright binaries (see
§17).
**Recommended remediation:** Add minimal mock handlers before any sessions
e2e test is written.

## [OBSERVATION] `refresh_token` returned by login is fetched but never used by the frontend

**Category:** Frontend / Session lifecycle
**Location:** `apps/web/src/lib/server/auth-client.ts:52-58`,
`actions.ts:53-63`
**Observed:** The BFF session cookie's expiry is pinned to the short-lived
access token's own `exp`; no silent-renewal path is wired, so users are
logged out on every access-token expiry (900s by default) rather than
seamlessly refreshed. Not a security defect — a functional gap outside what
this pass claimed to build.

**Verified TRUE:** auth code is genuinely server-only (`import 'server-only'`
/ `'use server'`, confirmed stripped from the client bundle and asserted by
an actual Playwright bundle-content test); access tokens are stored only in
an httpOnly cookie, never in `localStorage`/`sessionStorage`/a JS-readable
cookie (confirmed both statically and by a real e2e assertion); no password
logging anywhere; the open-redirect guard (`safeReturnPath`) is real and
tested against an actual malicious-redirect e2e case; no raw `fetch` calls
bypass the centralized API client outside the two documented, intentional
exceptions; no `NEXT_PUBLIC_`-prefixed secret exists; restore/purge use no
unsafe optimistic UI (`onSuccess`-only cache invalidation, nothing removed
from the UI before backend confirmation); the purge confirmation dialog is
genuinely gated on typing the exact book title, verified by a real
interaction test (wrong title → disabled, correct title → enabled, correct
`confirm_book_id` sent) rather than a decorative check; restore/purge
correctly defer authorization enforcement to the backend, matching the
established pattern used elsewhere in this app (e.g. the session-revoke
button).

---

## 16. Performance Findings

Not a primary focus of this audit given the higher-severity findings
elsewhere, and largely out of Phase 10's own stated scope (index coverage
for the progress/SSE surfaces was Phase 8 work, previously flagged
"applied but unmeasured"). No new N+1 pattern, unbounded query, or
synchronous storage operation inside a request path was identified in the
files reviewed across all seven passes. The retention sweep and purge
worker are both explicitly designed as background/async work, consistent
with architecture. No load/volume testing was performed or claimed by
either this audit or the self-report — this remains **UNKNOWN**, not PASS,
for both Phase 8 and Phase 10 surfaces alike.

---

## 17. Testing Results

Every test suite referenced by the self-report was independently executed
in this audit's environment, plus several the self-report marked
unrunnable — because live Postgres/Redis/MinIO (via a running Docker
Desktop backend not detectable through the `docker` CLI alone) and cached
Playwright browser binaries turned out to be available here, contrary to
this audit's own initial environment check and the self-report's sandbox.

| Package | Typecheck | Lint | Tests | Verified against self-report |
|---|---|---|---|---|
| @audio-book/config | PASS | not run separately | PASS 7/7 | CONFIRMED |
| @audio-book/contracts | PASS | — | PASS 6/6 | CONFIRMED |
| @audio-book/errors | PASS | — | PASS 4/4 | CONFIRMED |
| @audio-book/queue | PASS | — | PASS 4/4 | CONFIRMED |
| @audio-book/database | PASS | — | PASS 2/2 | CONFIRMED |
| @audio-book/api | PASS | PASS (1 pre-existing unrelated error, `assembly.service.ts`) | PASS 189/189 (19 files) | CONFIRMED |
| @audio-book/worker-cpu | PASS | PASS (32 pre-existing errors, untouched `assembly-*` files) | PASS 46/46 (8 files) | CONFIRMED |
| worker-gpu (Python) | BLOCKED — python3 is 3.9.6, repo requires 3.12 | `py_compile` PASS | BLOCKED — same reason | CONFIRMED as claimed (genuinely not runnable here) |
| @audio-book/web (unit/component) | PASS | PASS | PASS 227/227 (27 files) | CONFIRMED |
| @audio-book/web (production build) | PASS (`next build`, 19 routes) | — | — | CONFIRMED |
| @audio-book/web (e2e/Playwright) | — | not separately run | **PASS 139/139** (45 intentionally skipped, single-engine guards) | **DISCREPANCY** — self-report claimed "NOT TESTED, no browser binaries"; binaries were present in this environment and the suite runs against a self-contained mock API needing no live infra. Favorable discrepancy (under-claimed), not a fabrication. |
| `tests/contract/api-contract.test.ts` | — | — | PASS 35/35 | Additional coverage beyond self-report |
| `tests/e2e/application-layer.e2e.test.ts` | — | — | PASS 58/58 (against live Postgres/Redis/MinIO) | Additional coverage beyond self-report |
| `tests/e2e/full-pipeline.e2e.test.ts` | — | — | **3 FAILED / 7** (TTS stage stalls, cascading to assembly 409) | Pre-existing, untouched by Phase 10 diff; likely tied to the missing Python 3.12 worker-gpu runtime in this environment. Reported as informational, out of Phase 10's diff scope. |
| Root integration suite (9 files) | — | — | PASS 43/43 (live Postgres/MinIO/ffmpeg) | Additional coverage beyond self-report |

**Claimed total "485 tests, 485 passing" — CONFIRMED exactly** by
independent re-summation of the same rows.

**Migration applied against a live database:** still not attempted by
either the self-report or this audit — this audit did not run
`prisma migrate deploy` against the live instance found, in keeping with
the audit-only, no-repository-mutation, no-database-write mandate. This
remains a genuine, disclosed gap on both sides, and is the reason the
CRITICAL `OutboxMessage` FK defect (§11) was never caught: it can only
surface against a real, FK-enforcing database, which no automated run in
this project's history — including this audit — has exercised through an
actual purge.

---

## 18. Regression Results

No regression found in any Phase 1–9 carryover test. `books.service.test.ts`
(16/16), `buckets.test.ts` (8/8), and `maintenance.test.ts` (3/3) — all
modified-not-new files — pass in full as part of the package runs above.
The one regression-adjacent finding is informational only: the pre-existing,
Phase-10-untouched `full-pipeline.e2e.test.ts` fails in this specific
environment (TTS stage stall), which was not previously known because
neither Phase 8 nor Phase 10's own sessions had live infrastructure
available to discover it. This is noted for awareness, not scored against
Phase 10.

---

## 19. Documentation Consistency

Phase 10's application-layer documentation
(`identity-and-account-architecture.md`, `quota-and-usage-model.md`,
`storage-lifecycle.md`) is unusually candid about known limitations
(GPU_MINUTES untested, STORAGE_BYTES scope, no worker registry, no
tenant-level purge, no reverse-orphan reconciliation) and every one of those
disclosed limitations was independently confirmed accurate. However, the
documentation's confidence in claims it does *not* disclose as limitations —
enumeration-protection timing parity, refresh-token reuse-detection safety,
purge idempotency/completeness, "usage is never double-charged" — does not
hold up under independent tracing, per §5, §8, §9, and §11 above. The
production-readiness classification in the self-report
("READY WITH CONDITIONS") undersells risk that was findable by tracing the
same code the self-report itself cites as evidence, particularly for the
purge FK defect, which the self-report's own test evidence (in-memory mock
with no FK enforcement) could never have surfaced regardless of how
carefully it was read.

---

## 20. Finding Summary

| Severity | Count |
| --- | ---: |
| Critical | 4 |
| Major | 12 |
| Minor | 8 |
| Observation | 5 |

---

## 21. Remediation Priority

1. **Critical — purge FK gap** (§11): clear/redirect `OutboxMessage` rows
   before `book.deleteMany`; build the promised generic outbox-retention
   sweep. Blocks any real-database purge from ever succeeding.
2. **Critical — refresh-token reuse-detection race** (§5): make the
   rotation claim atomic. Blocks the theft-detection guarantee the
   mechanism exists to provide.
3. **Critical — `CONCURRENT_BOOKS` admission race** (§8): lock or
   constrain the check-and-transition sequence gating GPU-costing
   generation start.
4. **Major security** — `BookPurgeGuard` tenant-blind existence oracle;
   `QuotaGuard` missing on `VoiceController`; registration/login timing
   side-channels (§5, §8).
5. **Major data integrity** — non-transactional STORAGE_BYTES decrement;
   missing floor-at-zero on existing counters; concurrent-upload
   double-charge; Python transaction-poisoning risk; `BOOKS_TOTAL` race
   (§8, §9).
6. **Major reliability** — restore-vs-purge unguarded race (§11).
7. **Major architecture/frontend** — silent session-revoke failure;
   non-specific restore/purge error surfacing (§15).
8. **Minor** — `Retry-After` header gap; sessions-DELETE contract
   deviation; progressive-delay gap; lockout DoS surface; retention
   sweeper shutdown ordering; missing quota-guard test; missing sessions
   e2e mock; missing worker-crash-mid-purge test (§5, §8, §11, §15).
9. **Observations** — unreachable BROWSER auth path; unused frontend
   refresh token; `P2002` mapping centralization; documentation-confidence
   calibration (§5, §9, §15, §19).

---

## 22. Final Gate

**FAIL.**

Phase 10 does not meet the PASS bar (§38 of the audit brief: no Critical
findings, no unresolved Major findings, correct quota/usage accounting,
safe storage lifecycle, correct event contracts, meaningful concurrency
coverage). Four CRITICAL findings were independently confirmed by direct
code tracing, none disclosed in the self-report: a purge mechanism that
cannot complete against a real database for essentially any real book; an
authentication reuse-detection mechanism defeatable by concurrent replay;
and a quota-admission race that directly matches this audit's own named
CRITICAL example ("quota can be trivially bypassed for expensive
generation"). Twelve MAJOR findings compound the risk across security,
usage-accounting integrity, and lifecycle correctness. The passing test
suite — reproduced exactly, and extended with additional live-infrastructure
runs this audit was able to perform — does not contradict any of these
findings; it simply never exercised the conditions (true concurrency, a
real FK-enforcing database via an actual purge) under which they surface.
This is not a "verify before deploy" gap of the kind the self-report
itself names for its Python/e2e limitations — it is proof, by inspection
and by evidence gathered in this audit's own environment, that the
described behavior does not hold. Remediation is required before this
phase can be reconsidered for production deployment.
