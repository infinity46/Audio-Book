"""Regression guard for F-14 (see docs/qa/scorecard.md).

Prisma's `@updatedAt` is maintained by the Prisma *client*, so the generated
DDL gives `updated_at` no `DEFAULT` while still marking it `NOT NULL`. That
convention is invisible from Python, where these tables are written with
hand-written SQL through SQLAlchemy: a writer that omits the column fails with
`NotNullViolationError`, but only against a real database, so mocked unit
tests sail straight past it.

That is exactly what happened — the INSERT into `audio_script_chunk_source`
omitted `updated_at` and *every* Director run failed, while the sibling INSERT
into `audio_script_chunk` three lines above supplied it correctly.

This test cross-checks the two sides of that contract directly: it reads which
columns the migration actually requires, reads the INSERTs the Python repo
layer actually issues, and asserts they agree. Both halves are derived, never
hand-listed, so the guard stays correct as the schema evolves rather than
rotting into a stale allowlist.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# .../python/worker-ai/tests/this_file.py -> parents[2] is `python/`, [3] the repo root.
_PYTHON_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = Path(__file__).resolve().parents[3]
_MIGRATION = _REPO_ROOT / "prisma" / "migrations" / "0001_init" / "migration.sql"

_REPO_DIRS = [
    _PYTHON_ROOT / "worker-ai" / "src" / "worker_ai" / "repo",
    _PYTHON_ROOT / "worker-gpu" / "src" / "worker_gpu" / "repo",
]

_CREATE_TABLE_RE = re.compile(
    r'CREATE TABLE "(?P<table>[a-z_]+)" \((?P<body>.*?)\n\);',
    re.DOTALL,
)
_INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+(?P<table>[a-z_]+)\s*\((?P<columns>[^)]*)\)",
    re.IGNORECASE | re.DOTALL,
)


def _tables_requiring_updated_at() -> set[str]:
    """Tables whose `updated_at` is NOT NULL with no DEFAULT — i.e. every
    non-Prisma writer must supply it explicitly."""
    sql = _MIGRATION.read_text(encoding="utf-8")
    required: set[str] = set()
    for match in _CREATE_TABLE_RE.finditer(sql):
        for line in match.group("body").splitlines():
            stripped = line.strip()
            if not stripped.startswith('"updated_at"'):
                continue
            if "NOT NULL" in stripped and "DEFAULT" not in stripped:
                required.add(match.group("table"))
    return required


def _repo_inserts() -> list[tuple[Path, str, set[str]]]:
    found: list[tuple[Path, str, set[str]]] = []
    for directory in _REPO_DIRS:
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*.py")):
            for match in _INSERT_RE.finditer(path.read_text(encoding="utf-8")):
                columns = {
                    c.strip().lower() for c in match.group("columns").split(",") if c.strip()
                }
                found.append((path, match.group("table").lower(), columns))
    return found


def test_the_guard_has_something_to_check() -> None:
    """Guards the guard: a regex that silently matches nothing proves nothing."""
    assert _MIGRATION.exists(), f"migration not found at {_MIGRATION}"
    assert len(_tables_requiring_updated_at()) >= 10
    assert len(_repo_inserts()) >= 10


@pytest.mark.parametrize(
    ("path", "table", "columns"),
    [pytest.param(p, t, c, id=f"{p.name}:{t}") for p, t, c in _repo_inserts()],
)
def test_insert_supplies_updated_at_where_the_schema_requires_it(
    path: Path, table: str, columns: set[str]
) -> None:
    if table not in _tables_requiring_updated_at():
        pytest.skip(f"{table} does not require an explicit updated_at")
    assert "updated_at" in columns, (
        f"{path.name}: INSERT INTO {table} omits `updated_at`, which the migration "
        "declares NOT NULL with no DEFAULT (Prisma's @updatedAt is client-maintained). "
        "This fails only against a real database — see F-14 in docs/qa/scorecard.md."
    )
