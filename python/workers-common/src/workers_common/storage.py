"""S3-compatible object storage wrapper.

This mirrors the TypeScript `StorageProvider` contract conceptually, so that both languages
agree on semantics -- particularly on what `exists` means, what a checksum covers, and the
fact that a stored object's integrity is verified against `sha256 + size + content_type`
rather than against the provider's own ETag (which is not a content hash for multipart
uploads and therefore cannot be compared across providers).

## Why boto3 and not aioboto3

`boto3` is synchronous, so every call here is dispatched through `asyncio.to_thread`. That
is a deliberate trade: `aioboto3` pins `aiobotocore`, which in turn pins `botocore` to a
narrow range, and that pin propagates into every other AWS-touching dependency in the
lockfile. Worker storage calls are relatively few and large (upload an audio chunk, fetch a
text blob), so thread-pool dispatch costs essentially nothing here, while the dependency
freedom is worth a lot. If storage ever becomes a hot path with many small objects, this is
the module to revisit.

Phase 1 note: credentials are expected to carry a **narrow prefix grant**
(`event-contracts.md` §17.4) -- a worker holds access to its own prefix, not to the bucket.
Nothing here can enforce that; it is a property of the IAM policy attached to the key.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING, Any

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

from workers_common.config import WorkerSettings
from workers_common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from mypy_boto3_s3.client import S3Client
else:
    S3Client = Any

log = get_logger(__name__)


class StorageError(RuntimeError):
    """Any storage failure. Carries an `error_code` for the log contract."""

    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True, slots=True)
class Checksum:
    """The integrity triple. All three, together, identify a stored object's content.

    `sha256` alone would be enough for integrity, but size and content type are carried
    with it because they are what the *consumer* validates cheaply before downloading,
    and because a size mismatch is the fastest signal of a truncated upload.
    """

    sha256: str
    size_bytes: int
    content_type: str

    def as_log_fields(self) -> dict[str, Any]:
        return {
            "content_hash": self.sha256[:16],
            "content_length": self.size_bytes,
            "content_type": self.content_type,
        }


@dataclass(frozen=True, slots=True)
class ObjectMetadata:
    key: str
    size_bytes: int
    content_type: str
    etag: str
    last_modified: str | None = None
    sha256: str | None = None


def compute_checksum(data: bytes, *, content_type: str) -> Checksum:
    """sha256 + size + content type over the exact bytes that will be stored."""
    return Checksum(
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        content_type=content_type,
    )


# The custom metadata key the sha256 is stored under. Must match the TS side exactly, or
# cross-language verification silently degrades to "no hash recorded".
_SHA256_METADATA_KEY = "sha256"


class ObjectStorage:
    """Thin async wrapper over an S3-compatible bucket."""

    def __init__(self, settings: WorkerSettings) -> None:
        secrets = settings.secrets
        self._bucket = secrets.storage_bucket
        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=secrets.storage_endpoint_url,
            aws_access_key_id=secrets.storage_access_key_id.get_secret_value(),
            aws_secret_access_key=secrets.storage_secret_access_key.get_secret_value(),
            region_name=secrets.storage_region,
            config=BotoConfig(
                signature_version="s3v4",
                retries={"max_attempts": 3, "mode": "standard"},
                # Path-style addressing: MinIO and most non-AWS S3 implementations do not
                # support virtual-host style, and the deployment target may be either.
                s3={"addressing_style": "path"},
            ),
        )

    @property
    def bucket(self) -> str:
        return self._bucket

    async def _call(self, method: str, /, **kwargs: Any) -> Any:
        fn = partial(getattr(self._client, method), **kwargs)
        return await asyncio.to_thread(fn)

    async def put(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
        metadata: dict[str, str] | None = None,
    ) -> Checksum:
        """Store bytes and return their checksum.

        The sha256 is written into the object's user metadata so that a later reader can
        verify integrity without needing a side channel or a database round-trip.
        """
        checksum = compute_checksum(data, content_type=content_type)
        meta = {**(metadata or {}), _SHA256_METADATA_KEY: checksum.sha256}
        try:
            await self._call(
                "put_object",
                Bucket=self._bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
                Metadata=meta,
            )
        except ClientError as exc:
            raise StorageError(f"put failed for {key}", error_code="STORAGE_PUT_FAILED") from exc
        log.info("storage.put", storage_key=key, **checksum.as_log_fields())
        return checksum

    async def get(self, key: str, *, verify_sha256: str | None = None) -> bytes:
        """Fetch bytes, optionally verifying them against an expected hash.

        Verification is opt-in rather than automatic because the expected hash usually
        lives in the database row that pointed here, and the caller is the one holding it.
        """
        try:
            response = await self._call("get_object", Bucket=self._bucket, Key=key)
            body: bytes = await asyncio.to_thread(response["Body"].read)
        except ClientError as exc:
            raise StorageError(f"get failed for {key}", error_code="STORAGE_GET_FAILED") from exc

        if verify_sha256 is not None:
            actual = hashlib.sha256(body).hexdigest()
            if actual != verify_sha256:
                raise StorageError(
                    f"Checksum mismatch for {key}: expected {verify_sha256[:16]}, "
                    f"got {actual[:16]}",
                    error_code="STORAGE_CHECKSUM_MISMATCH",
                )
        return body

    async def exists(self, key: str) -> bool:
        """Whether the object is present.

        Implemented via HEAD. A 404 is a legitimate answer, not an error; anything else is
        a real failure and is raised, because treating a 403 as "does not exist" would turn
        a misconfigured credential into a silent data-loss bug.
        """
        try:
            await self._call("head_object", Bucket=self._bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise StorageError(
                f"exists check failed for {key}", error_code="STORAGE_HEAD_FAILED"
            ) from exc
        return True

    async def head(self, key: str) -> ObjectMetadata | None:
        """Metadata without the body. Returns None when the object is absent."""
        try:
            response = await self._call("head_object", Bucket=self._bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                return None
            raise StorageError(f"head failed for {key}", error_code="STORAGE_HEAD_FAILED") from exc

        last_modified = response.get("LastModified")
        return ObjectMetadata(
            key=key,
            size_bytes=int(response.get("ContentLength", 0)),
            content_type=str(response.get("ContentType", "application/octet-stream")),
            etag=str(response.get("ETag", "")).strip('"'),
            last_modified=last_modified.isoformat() if last_modified else None,
            sha256=response.get("Metadata", {}).get(_SHA256_METADATA_KEY),
        )

    async def delete(self, key: str) -> None:
        """Remove an object. Idempotent: deleting an absent key is not an error in S3."""
        try:
            await self._call("delete_object", Bucket=self._bucket, Key=key)
        except ClientError as exc:
            raise StorageError(
                f"delete failed for {key}", error_code="STORAGE_DELETE_FAILED"
            ) from exc
        log.info("storage.delete", storage_key=key)

    async def signed_url(
        self,
        key: str,
        *,
        expires_in_seconds: int = 900,
        operation: str = "get_object",
    ) -> str:
        """A time-limited pre-signed URL.

        Default 15 minutes. Deliberately short: these URLs are bearer credentials for the
        object, and audiobook content is exactly what must not leak through a long-lived
        link forwarded out of a support ticket.
        """
        try:
            url: str = await asyncio.to_thread(
                partial(
                    self._client.generate_presigned_url,
                    ClientMethod=operation,
                    Params={"Bucket": self._bucket, "Key": key},
                    ExpiresIn=expires_in_seconds,
                )
            )
        except ClientError as exc:
            raise StorageError(
                f"presign failed for {key}", error_code="STORAGE_PRESIGN_FAILED"
            ) from exc
        return url

    async def ping(self) -> bool:
        """Verify the bucket is reachable. Part of the STARTING -> HEALTHY check."""
        try:
            await self._call("head_bucket", Bucket=self._bucket)
            return True
        except (ClientError, StorageError) as exc:
            log.warning("storage.ping_failed", error_code="STORAGE_UNREACHABLE", error=str(exc))
            return False

    async def close(self) -> None:
        """Release the underlying HTTP pool during shutdown."""
        await asyncio.to_thread(self._client.close)
        log.info("storage.closed")
