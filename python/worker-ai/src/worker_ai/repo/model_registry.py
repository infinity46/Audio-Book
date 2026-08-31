"""`ModelRegistry`/`ModelVersion` resolution -- the Python mirror of
`apps/worker-cpu/src/processors/ingestion.ts`'s `resolveModelVersionId`.

Every semantic row this worker writes carries a real `ModelVersion` id. An
unregistered (role, provider_id, model_id, version) tuple is a terminal failure, not a
silent write with no provenance -- run `infra/scripts/seed.ts` (or the deployment's
equivalent) before analyzing anything.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.semantic.schemas import ModelIdentity
from workers_common.queue import TerminalJobError


async def resolve_model_version_id(session: AsyncSession, identity: ModelIdentity) -> str:
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
