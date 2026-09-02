# QA Strategy

**Status:** Phase 7, milestone 1. Covers what this repository actually tests
today and how those tests are organized. Anything not yet exercised is named
in [`scorecard.md`](./scorecard.md) as `UNKNOWN` rather than assumed to pass.

The authoritative design lives in `docs/architecture/`; this document does not
restate it. It answers one question: **what evidence do we have that the system
behaves as designed, and where does that evidence stop?**

---

## 1. The pyramid

Tests get more expensive and less numerous as they move down this list. The
shape is deliberate: a GPU or full-pipeline run is never the cheapest place to
catch a defect that a unit test could have caught.

| Layer | Where it lives | Runs against | Count today |
|---|---|---|---|
| **Unit** | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`, `python/*/tests/` | Pure functions, mocked ports | 224 TS + 301 Python |
| **Integration** | `tests/integration/*.integration.test.ts` | Real Postgres, Redis, MinIO, ffmpeg | 41 |
| **Contract** | Co-located (see §3) | Schemas + envelopes | included above |
| **E2E (mocked inference)** | `tests/e2e/*.e2e.test.ts` | Compiled services (TS + Python) over real HTTP, real queue/storage/DB | 21 |
| **E2E (real inference)** | Not built | Real models, real GPU | none |
| **Load / soak** | Not built | Production-like scale | none |

Nothing in the unit or integration layers requires a GPU, a real LLM, or a real
TTS model. That is a hard rule: the deterministic providers
(`DeterministicDirectorProvider`, `DeterministicSemanticAnalyzer`, the mock TTS
provider) exist so the whole orchestration layer stays testable on a laptop.

## 2. Environments

| Environment | Dependencies | How to run |
|---|---|---|
| `UNIT` | none | `pnpm -r test`; `uv run --package <pkg> pytest` |
| `INTEGRATION` | Postgres + Redis + MinIO (`docker compose up -d postgres redis minio minio-init`) | `pnpm test:integration` |
| `E2E-MOCK` | as INTEGRATION, plus the compiled services running as processes | `pnpm -r run build && pnpm test:e2e` |
| `E2E-REAL` | GPU host, real TTS/LLM models | **not built** |
| `GPU` | CUDA host | **not built** |
| `LOAD` | production-like cluster | **not built** |
| `SECURITY` | as INTEGRATION | `pnpm vitest run tests/integration/tenant-isolation.security.integration.test.ts` |

The last three are not aspirational placeholders — they are named here so that
claims about GPU behaviour, throughput, and concurrency are visibly untested
rather than quietly assumed.

## 3. Contract testing

`tests/contract/` is intentionally empty; contract coverage is co-located with
the thing it constrains, because a contract test that lives away from its
schema tends to drift from it:

- **HTTP request bodies** — AJV validation in strict mode against
  `packages/contracts/schemas/*.schema.json` (`ajv-validation.pipe.test.ts`).
- **Event/command envelopes** — `packages/events/src/envelope.test.ts`.
- **Audio Script IR** — strict Pydantic models (`extra="forbid"`) in
  `python/worker-ai/src/worker_ai/director/schemas.py`; unknown fields are a
  hard validation error, never silently dropped.
- **Storage provider** — one shared suite (`runStorageProviderContractTests`)
  run against both the in-memory and the real MinIO implementation, so the two
  cannot diverge.

## 4. Golden fixtures

`packages/ingestion/src/test-fixtures/build-fixtures.ts` generates every
document fixture at test time. Nothing copyrighted, and no binary blobs, are
committed.

`buildGoldenBookPdf()` is the Phase 7 text-fidelity fixture: one document
carrying narrator prose, two-speaker dialogue with nested quotes, a line-break
hyphenation, a chapter transition, numbers and dates, a foreign phrase, and
OCR-style noise (a header and bare page-number footer repeated on every page).
Expected results are hand-written in `golden-book.expected.ts` and asserted by
`golden-book.test.ts`.

The fidelity gate checks **counts, not just presence** — a phrase appearing
twice fails as hard as one that vanished, because duplication is as damaging to
a narration as loss.

Generated audio is never committed. Audio fixtures are synthesized at test time
with ffmpeg (`assembly.integration.test.ts`) and verified by re-probing the
output, including a bandpass check that proves segment ordering from the actual
decoded waveform rather than from database rows alone.

## 5. Mocked end-to-end

`tests/e2e/` boots the **compiled** services as child processes and drives them
over real HTTP against real Postgres, Redis, and MinIO: `apps/api`, `worker-cpu`
when a test needs jobs consumed, and the Python `worker-ai` / `worker-gpu` when
a test needs the stages they own. `tests/e2e/harness.ts` handles the lifecycle:
it generates a throwaway RS256 keypair per run, feeds the public key to the API
as configuration, mints tokens the running service genuinely verifies, waits for
each Python worker's `/ready` (which reports only once its model provider has
loaded), and tears everything down.

Teardown signals each service's **process group**, not just the child. `uv run`
execs a separate interpreter, so signalling only the wrapper leaks the worker —
and a leaked worker keeps consuming the shared Redis queues, meaning a later
run's job can be picked up by an earlier run's process whose output nothing is
reading. That produced a genuinely confusing failure during this milestone (a
job stuck `RUNNING` with no error and no trace in the live worker's log), so the
harness also exposes `logs()` and the pipeline test attaches the worker's tail
to any stage timeout.

It runs `dist/` rather than the sources deliberately — NestJS needs
`design:paramtypes`, which only `tsc` emits, so an esbuild-based in-process app
would fail to inject anything (this is F-13's root cause). Running what ships is
also the point of an end-to-end test.

Three suites today:

- `api-http.e2e.test.ts` — the HTTP contract that nothing previously covered:
  liveness/readiness, authentication (including a token signed by a foreign
  key), the authorization rules from §6, tenant isolation returning `404` over
  the wire, idempotency replay, strict-mode field rejection, the §8.1 error
  envelope, and the absence of internals in error bodies. It carries an
  explicit regression test for F-13, since a DI failure shows up precisely as
  "`/health` fine, every real route 500".
- `ingestion-pipeline.e2e.test.ts` — one real PDF across every process
  boundary: upload session → signed URL → MinIO → completion → `ProcessingJob`
  + Redis → worker-cpu → real parser → Postgres → HTTP reads. It asserts the
  golden fixture's chapters and text fidelity *after* the full crossing, not
  just at the parser, and checks the artifact's lineage (job → book file →
  book version, with parser and normalizer provenance recorded).
- `full-pipeline.e2e.test.ts` — the same document carried further, and across
  the language boundary: ingestion (TypeScript) → narrative analysis → Director
  IR (both Python `worker-ai`, over the shared `ai` queue). It asserts the IR
  reaches `VALIDATED`, that coverage is verified with zero gaps and zero
  overlaps, that every chunk carries a speaker from the closed vocabulary, and
  that lineage crosses the boundary unbroken — the `AudioScript` pointing at the
  `BookVersion` the TypeScript worker produced and the Story Bible the Python
  worker produced, with matching `sourceContentHash`.

  This suite is what exercises `architecture-review.md`'s High-Risk #9
  (TypeScript/Python contract drift), and it earned its keep immediately: it
  found F-14, a schema-convention mismatch that made Director generation fail
  100% of the time against a real database.

Below the E2E layer, two integration tests still cover the orchestration spine
directly with no real inference:

- `final-integration.test.ts` — Postgres transaction → outbox → Redis → real
  worker → inbox → state update, using the real `OutboxPublisher`,
  `QueueManager`, and worker processor functions.
- `processing-job-sweeper.integration.test.ts` — a job orphaned between the
  Postgres commit and the Redis enqueue is recovered by the real sweeper and
  processed by the real `parse` worker.

**Where this still stops.** The chain runs upload → ingestion → analysis →
Director. It does **not** yet continue into TTS → assembly → mastering →
packaging in one run. Two things are missing rather than one: `worker-gpu` is
not yet started by the harness (the option exists and the mock TTS provider
needs no GPU), and TTS cannot begin until characters have voices assigned, so
the test would first have to drive the casting endpoints. Those later stages are
each covered on their own — TTS in the Python suites, and
assembly/mastering/packaging end-to-end with real ffmpeg and real MinIO in
`assembly.integration.test.ts` — but the seams between them are still exercised
only by hand.

Closing that is what would move scorecard row 25 from `PARTIAL` to a fully
measured result, and given what the first cross-language seam turned up, it is
the highest-value remaining test work.

## 6. Security testing

`tenant-isolation.security.integration.test.ts` seeds two real tenants and
attacks tenant A's resources with tenant B's principal across all six business
services, in two shapes: a foreign book id, and ID substitution (tenant B's own
book id paired with tenant A's sub-resource id — the case the ownership check
alone does not catch). Every attempt must raise `NotFoundError`; a 403 would
itself leak existence across the tenant boundary.

Authorization is covered at two levels: `tenant-role.guard.test.ts` asserts the
§6.6 administrator content boundary and deny-by-default role checks at the
guard, and the isolation suite above asserts ownership in the services beneath
it — the spec (§6.1) requires both, and explicitly forbids relying on the
gateway alone.

Rate limiting is covered by `buckets.test.ts` (every route resolves to exactly
one §14.3 bucket, so none is silently unlimited) and
`rate-limit.integration.test.ts` (real Redis: limits, per-dimension counting,
TTLs, and the fail-open path when Redis is unreachable).

`python/worker-ai/tests/test_prompt_injection_resistance.py` treats book text as
hostile input. It pins the two defenses that are enforceable in code rather
than by prompt wording: the resolver can only ever return an identity already
in the caller-supplied registry, and the provider's output schema has no
speaker-shaped field for an injected instruction to populate.

## 7. Regression policy

- A discovered defect becomes a test **before** it is fixed.
- A known-but-unfixed defect is recorded with `it.fails` (vitest) so that the
  suite states the truth: it asserts the correct behaviour and records that it
  does not yet hold. Whoever fixes it is told by the runner that the test now
  passes unexpectedly, and promotes it. See the cross-page hyphenation case in
  `golden-book.test.ts`.
- A change to any value in `golden-book.expected.ts` is a deliberate,
  reviewable statement that canonical output legitimately changed. It is never
  edited to make a failing test pass.
- Any change to normalization that alters canonical text requires a
  `normalizationVersion` bump, because content hashes and every downstream
  lineage claim depend on it.

## 8. What this strategy does not cover

Named explicitly so it is never mistaken for coverage: real-model TTS quality,
speaker-embedding similarity, GPU memory and scheduling behaviour, throughput
and concurrency limits, long-form (10h+/20h+) audiobook assembly, 100k-segment
orchestration, disaster recovery, backup/restore, and human/subjective audio
evaluation. Each appears in the scorecard with status `UNKNOWN` and the reason
it was not measured.
