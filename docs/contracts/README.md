# Cross-language contract convention

Source of truth: `context.md` §23 row 26 — "JSON Schema is the neutral source
from which TypeScript types and Pydantic models are generated," because the
system spans two languages (TypeScript services, Python workers) and
"contract duplication across languages is a known hazard."

## Where schemas live

```
packages/contracts/schemas/*.schema.json     # the source of truth
packages/contracts/src/generated/*.ts        # generated TS types (checked in)
python/workers-common/src/workers_common/generated/*.py   # generated Pydantic models (checked in)
```

Generated output is committed to the repo (not generated at build time only)
so that a diff review can see contract changes directly, and so CI can detect
drift by regenerating and diffing against what's checked in.

## Regenerating

```
pnpm --filter @audio-book/contracts run generate   # TS
uv run --package workers-common python -m workers_common.generate  # Python
```

CI runs both and fails if the working tree differs afterward — that's the
drift check, not a style preference.

## What exists today (Phase 1)

Only the **event envelope** and **command envelope** (`docs/architecture/
event-contracts.md` §6–§7) are schematized here. Every other contract in the
system — the Audio Script IR in particular — is deliberately **not**
schematized yet:

- The Audio Script IR's vocabularies (emotion, delivery mode, etc.) are owned
  by `director-specification.md`, and `audio-script-ir.md` itself flags this
  as an open question (OQ-IR-7: "where do the IR JSON Schemas live, and who
  reviews changes?") that is explicitly **not settled**, only deferred, with
  an interim answer of "this directory" — not yet acted on.
- Business event payloads (the 36 `event_type` names' individual payload
  shapes) are out of Phase 1 scope; only the envelope around them is built
  here. Payload schemas get added incrementally as each business event is
  actually implemented in a later phase.

Do not add IR or business-event-payload schemas here speculatively — per the
Phase 1 task boundary, this phase builds the codegen **pipeline and
convention**, applied to the one contract (the envelope) that is fully
specified today.

## Adding a new schema

1. Add `packages/contracts/schemas/<name>.schema.json` (draft-07, `$id` set,
   `additionalProperties: false` unless the architecture doc explicitly says
   otherwise).
2. Run both generate commands above.
3. Add a matching Ajv-based validation contract test under
   `tests/contract/`.
4. Reference the exact architecture doc section the schema was transcribed
   from in a `description` field — never invent a field that isn't in the
   source document.
