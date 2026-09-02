"""`ModelRegistry`/`ModelVersion` resolution.

Identical in shape to `worker_ai.repo.model_registry` (same structural `_ModelIdentityLike`
Protocol, same query, same terminal-failure behavior). Duplicated rather than imported
cross-package: `worker-gpu` and `worker-ai` are separate deployment units
(`deployment-architecture.md` §3.1 -- GPU isolation is mandatory, never co-located), and a
Python import from one worker package into another would quietly reintroduce the coupling
that separation exists to prevent. The module is ~30 lines; the duplication cost is far
lower than the coupling cost.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.queue import TerminalJobError


@runtime_checkable
class _ModelIdentityLike(Protocol):
    @property
    def role(self) -> str: ...
    @property
    def provider_id(self) -> str: ...
    @property
    def model_id(self) -> str: ...
    @property
    def version(self) -> str: ...


async def resolve_model_version_id(session: AsyncSession, identity: _ModelIdentityLike) -> str:
    row = (
        await session.execute(
            text(
                """
                SELECT mv.id
                FROM model_version mv
                JOIN model_registry mr ON mr.id = mv.model_registry_id
                WHERE mr.role = :role AND mr.provider_id = :provider_id
                  AND mr.model_id = :model_id AND mv.version = :version
                """
            ),
            {
                "role": identity.role,
                "provider_id": identity.provider_id,
                "model_id": identity.model_id,
                "version": identity.version,
            },
        )
    ).first()
    if row is None:
        raise TerminalJobError(
            f"No ModelVersion registered for {identity.role}/{identity.provider_id}/"
            f"{identity.model_id}/{identity.version}. Run the seed script before synthesizing.",
            error_code="MODEL_VERSION_NOT_REGISTERED",
        )
    return str(row[0])


__all__ = ["resolve_model_version_id"]
