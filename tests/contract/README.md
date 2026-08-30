# Contract tests

The contract tests referenced in the Phase 1 plan (event envelope, Outbox,
Inbox, StorageProvider, Queue) are co-located with the code they test rather
than duplicated here, so they run as part of each package's own `pnpm test`
as well as under `pnpm test:contract`:

- Event/command envelope schema validation: `packages/contracts/src/validators.test.ts`
- StorageProvider contract suite (reusable against any implementation):
  `packages/storage/src/contract.ts`, exercised by
  `packages/storage/src/in-memory-provider.test.ts` (fake) and
  `tests/integration/storage.integration.test.ts` (real MinIO)
- Outbox/Inbox: exercised end-to-end in
  `tests/integration/final-integration.test.ts`, which uses the same
  `OutboxPublisher`/`withInbox` production code paths as apps/api and
  apps/worker-cpu
- Queue (enqueue/retry/DLQ): `tests/integration/queue.integration.test.ts`

`pnpm test:contract` runs with `--passWithNoTests` since this directory is
intentionally empty — it exists as a documented placeholder in case a future
phase needs a genuinely cross-package contract test that doesn't belong to
any single package (e.g. a TTSProvider/LLMProvider contract test once those
interfaces exist).
