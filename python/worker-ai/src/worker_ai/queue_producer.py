"""Enqueues the next command in the `analyze_scene` -> `build_story_bible_delta` ->
`analyze_scene` (next chapter) chain onto the `ai` BullMQ queue.

Builds the exact JSON shape `packages/queue/src/job-payload.ts`'s `QueueJobEnvelope`
produces on the TypeScript side (`{job_id, entity_id, correlation_id, causation_id,
tenant_id, payload}`) -- see `workers_common.events.SimpleJobEnvelope`'s docstring for
why that is the real wire contract rather than the fuller `CommandEnvelope`. This is
the one place worker-ai acts as a queue PRODUCER rather than a consumer.

`backoff: {"type": "exponential", ...}` is used here rather than TS's `{"type":
"custom"}` -- the custom strategy requires a matching `backoffStrategy` function
registered on the consuming `Worker`, which `workers_common.queue.QueueConsumer`
(the Worker that will actually pick these jobs back up) does not register. A plain
exponential backoff is a safe, self-contained default that needs no cross-language
strategy registration.
"""

from __future__ import annotations

from typing import Any, Protocol

from bullmq import Queue

AI_QUEUE_NAME = "ai"


class QueueProducer(Protocol):
    """Narrow enough that handler tests can pass an in-memory fake."""

    async def enqueue(
        self,
        *,
        job_name: str,
        job_id: str,
        correlation_id: str,
        causation_id: str | None,
        tenant_id: str,
        entity_id: str | None,
        payload: dict[str, Any],
        max_attempts: int = 3,
    ) -> None: ...


class BullMqAiQueueProducer:
    def __init__(self, *, redis_url: str, queue_prefix: str = "bull") -> None:
        self._queue = Queue(AI_QUEUE_NAME, {"connection": redis_url, "prefix": queue_prefix})

    async def enqueue(
        self,
        *,
        job_name: str,
        job_id: str,
        correlation_id: str,
        causation_id: str | None,
        tenant_id: str,
        entity_id: str | None,
        payload: dict[str, Any],
        max_attempts: int = 3,
    ) -> None:
        data = {
            "job_id": job_id,
            "entity_id": entity_id,
            "correlation_id": correlation_id,
            "causation_id": causation_id,
            "tenant_id": tenant_id,
            "payload": payload,
        }
        await self._queue.add(
            job_name,
            data,
            {
                "jobId": job_id,
                "attempts": max_attempts,
                "backoff": {"type": "exponential", "delay": 2000},
                "removeOnComplete": {"age": 86400},
                "removeOnFail": False,
            },
        )

    async def close(self) -> None:
        await self._queue.close()
