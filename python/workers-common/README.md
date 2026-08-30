# workers-common

Shared Phase 1 infrastructure for the Python workers (`worker-ai`, `worker-gpu`).

**This package contains plumbing only.** There is no Director prompt construction, no LLM
call, no TTS inference, and no audio processing anywhere in it. The two worker apps are
deliberately thin; anything reusable lives here.

| Module        | Responsibility                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| `config`      | Fail-fast `pydantic-settings` configuration, split into the four contract categories |
| `logging`     | `structlog` setup emitting the required field set, plus book-content redaction       |
| `correlation` | `contextvars` binding of correlation / causation / job / worker ids                  |
| `db`          | Async SQLAlchemy engine + session factory, graceful dispose                          |
| `queue`       | BullMQ-compatible consumer (see below)                                               |
| `events`      | Command and event envelopes mirroring `event-contracts.md` §6 and §7                 |
| `storage`     | S3-compatible object store wrapper + checksum helper                                 |
| `health`      | Worker lifecycle state machine + FastAPI `/health` and `/ready` router               |

## Queue compatibility with the Node BullMQ producer

The consumer in `queue.py` wraps **the official `bullmq` PyPI package**, which is published by
Taskforcesh — the same authors as the Node BullMQ library — and is a real port rather than a
third-party reimplementation. It speaks BullMQ's Redis key conventions and executes the same
bundled Lua scripts as the Node client, so job state transitions (`wait` → `active` →
`completed`/`failed`, delayed-set retries, stalled-job recovery, DLQ) are performed by
BullMQ's own atomic scripts and not by anything hand-rolled here.

Nothing wire-level is invented in this repository. What `queue.py` adds is only: envelope
decoding, correlation-id binding, and drain-on-SIGTERM sequencing.

### Compatibility assumptions a human should verify against the Node side

1. **Version skew.** The Python client's Lua scripts must match the Redis-side data
   structures written by the Node producer. Keep the Python `bullmq` major version in step
   with the Node `bullmq` major version, and pin both. A mismatch is the single most likely
   source of subtle breakage.
2. **Queue prefix.** BullMQ namespaces every key as `{<prefix>:<queue>}:...`, with the
   prefix defaulting to `bull`. The producer and consumer must agree. Exposed here as
   `QueueSettings.queue_prefix`.
3. **Job name vs. `message_type`.** BullMQ has its own per-job `name`. The envelope also
   carries `message_type`. This code treats **the envelope's `message_type` as
   authoritative** and only logs the BullMQ job name, per `event-contracts.md` §4.3 (no
   broker construct is load-bearing). Confirm the producer sets both consistently.
4. **Payload shape.** The producer must place the entire envelope (§6.1) as the BullMQ job
   `data` object. This consumer validates `data` against `CommandEnvelope` and rejects
   anything that does not conform.
5. **Retry/backoff ownership.** Attempt counts and backoff live in the producer's
   `JobsOptions` at enqueue time, not here. `queue.py` decides only _whether_ a failure is
   retryable (`nack(retryable=...)`); BullMQ decides _when_ the retry runs. Per-queue
   attempt budgets are specified in `event-contracts.md` §5.2.

### Known gaps in the Python client (Phase 1 scope)

- Feature parity with the Node client trails it. Flows/parent-child jobs and some rate-limit
  and metrics surfaces are less complete on the Python side. None of those are needed by a
  Phase 1 consumer, but a human should re-check before relying on them.
- `lease_fence` (§6.2) is _carried_ through the envelope and bound into the log context here,
  but it is **not enforced** — enforcement is a database-side concern
  (`database-schema.md` §15.1) and is out of Phase 1 scope.
