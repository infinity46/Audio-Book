"""`ModelRegistry`/`ModelVersion` resolution -- the Python mirror of
`apps/worker-cpu/src/processors/ingestion.ts`'s `resolveModelVersionId`.

Every semantic row this worker writes carries a real `ModelVersion` id. An
unregistered (role, provider_id, model_id, version) tuple is a terminal failure, not a
silent write with no provenance -- run `infra/scripts/seed.ts` (or the deployment's
equivalent) before analyzing anything.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.queue import TerminalJobError


@runtime_checkable
class _ModelIdentityLike(Protocol):
    """Structural type covering both `semantic.schemas.ModelIdentity` and
    `director.schemas.ModelIdentity` -- two independently-versioned Pydantic
    models with the same (role, provider_id, model_id, version) shape.
    Resolution is a generic (role, provider_id, model_id, version) lookup, so
    this module deliberately does not import either concrete model and
    thereby couple the two provider families to each other.

    Declared as read-only properties, not plain attributes: Protocol
    structural matching compares attributes invariantly but properties
    covariantly, so a concrete model whose `role` is the narrower
    `Literal["LLM"]` (both current models) still satisfies `role: str` here.
    """

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
            f"{identity.model_id}/{identity.version}. Run the seed script before analyzing.",
            error_code="MODEL_VERSION_NOT_REGISTERED",
        )
    return str(row[0])
