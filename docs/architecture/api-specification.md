# API Specification — Audiobook Production Platform

> **Document type:** Contract of record (Tier 1 — HTTP surface)
> **Path:** `docs/architecture/api-specification.md`
> **Status:** DRAFT — pending human review
> **Schema/Doc version:** `api-spec.v1`
> **API version:** `v1`
> **Owner:** Architecture
> **Derives from:** `docs/architecture/context.md` (`context.v1`), Tier 0 root authority
> **Supersedes:** nothing (initial document)

---

## 0. How to read this document

This document is the **only authority on endpoints, paths, payload shapes, status codes,
error codes, pagination shape, casing, and authentication behavior** (`context.md` §26.1
rule 2). It inherits every constraint in `context.md` and may not contradict it. Where this
document appears to disagree with `context.md`, `context.md` wins and this document has a
defect that must be fixed under change control (`context.md` §27).

`MUST` / `SHOULD` / `MAY` carry the meanings defined in `context.md` §0.

It deliberately stops short of implementation: no controllers, no routes, no DTO classes,
no ORM models, no migrations, no framework choices beyond what `context.md` §23 already
decided.

**Scope boundaries — what this document does *not* own:**

| Concern | Owner |
| --- | --- |
| Tables, columns, types, indexes, migrations | `database-schema.md` |
| Queue names, job payload schemas, event names and schemas | `event-contracts.md` |
| Concrete Audio Script IR field types and enum members | `audio-script-ir.md` |
| Emotion / delivery-mode / pacing closed vocabularies | `director-specification.md` |
| Engine-specific translation of IR to TTS controls | `tts-provider-specification.md` |
| Timeouts, retention windows, concurrency numbers, loudness targets, rate-limit values | `deployment-architecture.md` |

Where this document names a value that is really configuration (a limit, a TTL, a maximum),
it states the **contractual shape and its bounds** and marks the numeric value as
`configuration` — the actual number is recorded in `deployment-architecture.md`. Clients
**MUST NOT** hardcode such values; they are discoverable through the endpoints in §16.21.

---

## 1. Table of contents

1. [How to read this document](#0-how-to-read-this-document)
2. [Global conventions](#2-global-conventions)
3. [API layers](#3-api-layers)
4. [Resource model](#4-resource-model)
5. [Authentication](#5-authentication)
6. [Authorization and ownership](#6-authorization-and-ownership)
7. [Response conventions](#7-response-conventions)
8. [Error contract](#8-error-contract)
9. [HTTP status codes](#9-http-status-codes)
10. [Pagination, filtering, sorting](#10-pagination-filtering-and-sorting)
11. [Idempotency](#11-idempotency)
12. [Request validation](#12-request-validation)
13. [The API to Job to Event relationship](#13-the-api-to-job-to-event-relationship)
14. [Security requirements](#14-security-requirements)
15. [Endpoint catalog](#15-endpoint-catalog)
16. [Public API — endpoint specifications](#16-public-api--endpoint-specifications)
17. [Internal service APIs](#17-internal-service-apis)
18. [Worker / job interfaces](#18-worker--job-interfaces)
19. [Health and readiness](#19-health-and-readiness)
20. [State vocabularies (binding)](#20-state-vocabularies-binding)
21. [Error code registry](#21-error-code-registry)
22. [API versioning and compatibility](#22-api-versioning-and-compatibility)
23. [Contract integrity audit](#23-contract-integrity-audit)
24. [Open architectural questions](#24-open-architectural-questions)
25. [Rules for Future Implementation](#25-rules-for-future-implementation)

---

## 2. Global conventions

### 2.1 Base URL and versioning

```
https://{host}/api/v1/...
```

- The **only** public API version is `v1`. `context.md` §25.2 permits a new major version
  only for a breaking change; no compatibility-breaking requirement is known today, so
  `/api/v2` **MUST NOT** be introduced by this document or by any implementation phase.
- Payload schema versions (Audio Script IR `schema_version`, event `schema_version`) are
  **independent** of the API version and travel inside payloads.
- Deprecation is announced with `Deprecation` and `Sunset` response headers plus a
  `documentation_url`; nothing is removed silently.

### 2.2 Transport

- HTTPS only. Plain HTTP is refused, not redirected, for `/api/**`.
- `Content-Type: application/json; charset=utf-8` for all request and response bodies.
  The single exception is Server-Sent Events (`text/event-stream`, §16.19).
- The API **never** carries file bytes. Uploads and downloads go directly between the
  client and object storage via short-lived signed URLs (`context.md` §3.2.5, §25.8).
- `Accept-Encoding: gzip` supported. No other content negotiation.

### 2.3 Casing — resolution of `context.md` open question Q7

`context.md` §25.1 requires one casing convention chosen once and applied universally, and
delegates the choice to this document.

**Decision: `snake_case` for every JSON field name, every query parameter, and every
enum-adjacent key.** Rationale: the lineage tuple (`context.md` §2.4), the IR field names
(§7.2), the event envelope (§11.3), the idempotency keys (§16.3) and the error envelope
(§25.6) are already written in `snake_case` in the Tier 0 document. Choosing `camelCase`
would force a translation layer at exactly the boundary where drift between the TypeScript
and Python contract bindings (§30.11 tension 1) is most dangerous.

Consequences, all binding:

- Response and request field names: `snake_case` (`book_id`, `next_cursor`, `created_at`).
- Query parameters: `snake_case` (`chapter_id`, `include_total`).
- HTTP headers: conventional `Kebab-Case` (`Idempotency-Key`, `X-Request-Id`).
- Enum **values**: `SCREAMING_SNAKE_CASE`, matching `context.md` §4.4 and §16.1 exactly.
- Path segments: lowercase, plural nouns, hyphenated when multi-word (`/voice-profiles`,
  `/story-bible`, `/audio-script-chunks`). See OQ-2 in §24 for the `context.md` §25.1
  wording ambiguity this resolves.
- Path parameter placeholders in *this document* are written `{bookId}` for readability,
  matching `context.md` §25.1. Placeholder spelling is documentation notation only; it has
  no runtime meaning and imposes nothing on implementations.

### 2.4 Identifiers

- All entity identifiers are opaque strings (UUIDv7 or ULID per `context.md` §4.1).
  Clients **MUST** treat them as opaque: no parsing, no sorting by ID, no meaning inferred.
- Format validation at the edge: an identifier that is not a well-formed UUIDv7/ULID is a
  `422 VALIDATION_FAILED`, not a `404`.
- Identifiers are globally unique across tenants; ownership is still checked on every
  access (§6).

### 2.5 Timestamps, durations, sizes

- Timestamps: RFC 3339 / ISO 8601 in **UTC** with an explicit `Z`
  (`2026-08-27T11:04:03.221Z`). Field names end in `_at`.
- Durations: integer milliseconds, field names end in `_ms`. Audio durations additionally
  expose `duration_seconds` as a float where human display needs it.
- Byte sizes: integers, field names end in `_bytes`.
- Cost values are **not** exposed on the public API in v1 (`context.md` §17.2 makes cost an
  operator metric); they appear only on internal and administrative endpoints.

### 2.6 Standard request headers

| Header | Required | Applies to | Meaning |
| --- | --- | --- | --- |
| `Authorization: Bearer <access_token>` | Conditional | All authenticated endpoints | Bearer access token (§5). Mutually exclusive with cookie session on the same request. |
| `Cookie: session=<...>` | Conditional | Browser clients | `HttpOnly`, `Secure`, `SameSite=Lax` session cookie (§5.4). Requires the CSRF header on unsafe methods. |
| `X-CSRF-Token` | Yes for cookie-authenticated unsafe methods | `POST`/`PATCH`/`PUT`/`DELETE` | Double-submit CSRF token (§14.6). |
| `Idempotency-Key` | Yes where §11 marks it mandatory | Unsafe, expensive `POST` | Client-generated key (§11.2). |
| `X-Request-Id` | Optional | All | Client-supplied correlation id; echoed back. Server generates one when absent. |
| `traceparent` | Optional | All | W3C trace context; propagated into job envelopes (`context.md` §17.3). |
| `If-Match: <etag>` | Conditional | Concurrency-sensitive `PATCH` | Optimistic concurrency (§2.8). |
| `Content-Length` | Yes on bodies | All bodied requests | Enforced against the request-size limit (§14.4). |
| `Accept-Language` | Optional | All | Affects human-readable `message` text only, never `code`. |

### 2.7 Standard response headers

| Header | Always | Meaning |
| --- | --- | --- |
| `X-Request-Id` | Yes | Correlates with `error.request_id` and with server logs. |
| `X-Trace-Id` | Yes | Correlates with `context.md` §17.3 traces. |
| `ETag` | On single-resource `GET` of mutable resources | Optimistic concurrency token. |
| `Retry-After` | On `429`, `503` | Seconds, or an HTTP-date. |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | On rate-limited routes | Current bucket state (§14.3). |
| `Location` | On `201`, and on `202` where a job resource was created | URL of the created resource or job. |
| `Cache-Control` | Yes | `no-store` for everything authenticated, by default. |
| `Deprecation`, `Sunset` | When applicable | §2.1. |

### 2.8 Concurrency control

Mutable resources (`Book`, `Chapter`, `Character`, `VoiceProfile`, user profile) return an
`ETag` on single-resource `GET`. A `PATCH` **MAY** carry `If-Match`. When `If-Match` is
present and stale, the response is `409 RESOURCE_VERSION_CONFLICT`. When absent,
last-write-wins applies to the fields present in the patch body only.

Immutable resources (`AudioScriptChunk` after freeze, `AudioChunk`, `ChapterAudio`,
`Audiobook`, `VoiceProfileVersion` once `LOCKED`, `ProcessingAttempt`, `BookFile`,
`NarrativeState`) expose no mutation endpoint at all. Attempting one is `405` where the
method is universally unsupported for the resource, and `409` where the resource's *state*
is what forbids the write (§9.2).

### 2.9 Null, absent, and unknown

- `null` means "known to be absent."
- An **omitted** field in a `PATCH` body means "leave unchanged." `null` in a `PATCH` body
  means "clear this field" and is rejected for non-nullable fields.
- Responses **MUST NOT** omit contractual fields; a field with no value is `null`.
- Unknown fields in a request body are **rejected** (`context.md` §25.5 strict mode), not
  ignored: `422 VALIDATION_FAILED` with `details[].issue = "unknown_field"`.

---

## 3. API layers

Three layers exist. They are separated by network reachability, by credential type, and by
this document's structure. **A public client can reach layer 1 only.**

| Layer | Prefix | Reachable from | Credential | Specified in |
| --- | --- | --- | --- | --- |
| **1 — Public Client API** | `/api/v1/...` | Internet, through the API Gateway | User access token or session cookie | §16 |
| **2 — Internal Service API** | `/internal/v1/...` | Private network only | Service token / mTLS (§5.6) | §17 |
| **3 — Worker control surface** | `/internal/v1/...` on the worker process | Private network only | Service token / mTLS | §18 |
| **Operational** | `/health`, `/ready`, `/metrics` | Orchestrator / private network only | None for `/health`, `/ready`; service token for the rest | §19 |

Binding rules:

1. Layer 2 and layer 3 paths **MUST NOT** be routed by the public ingress. This is an
   infrastructure control, not only a code check (`context.md` §3.2.1).
2. A public endpoint **MUST NOT** be created as a thin pass-through to an internal endpoint.
   Public endpoints are designed for clients; internal endpoints are designed for services.
3. Workers **MUST NOT** be addressable by any public client, directly or by proxy
   (`context.md` §10.1, §24.3). There is no public endpoint that names a worker, a host, a
   queue, a Redis key, or an object-storage bucket.
4. Domain work reaches workers **only** through the queue. Layer 3 exists solely for health,
   capability reporting, and the bounded Director dry-run (`context.md` §23 row 4, §30.6).

**Public client audiences.** The web application and a future mobile application are
first-class consumers of layer 1. External third-party clients are supported only where an
endpoint says so; in v1 no endpoint is designated third-party, because programmatic API
keys are not part of v1 (OQ-7, §24). The contract is nevertheless written to be usable by a
non-browser client: nothing depends on cookies except the browser session path.

---

## 4. Resource model

### 4.1 Public resource tree

```
/api/v1/auth/...                                    (sessions, tokens — no entity)
/api/v1/users/me                                    -> User
/api/v1/users/me/quotas                             -> User (usage aggregates)
/api/v1/users/me/sessions                           -> sessions (Auth)
/api/v1/books                                       -> Book
/api/v1/books/{bookId}
/api/v1/books/{bookId}/files                        -> BookFile
/api/v1/books/{bookId}/files/{bookFileId}
/api/v1/books/{bookId}/upload-sessions              -> upload session (ephemeral, Redis)
/api/v1/books/{bookId}/upload-sessions/{sessionId}
/api/v1/books/{bookId}/ingestion                    -> stage command + state
/api/v1/books/{bookId}/chapters                     -> Chapter
/api/v1/books/{bookId}/chapters/{chapterId}
/api/v1/books/{bookId}/sections                     -> Section
/api/v1/books/{bookId}/scenes                       -> Scene
/api/v1/books/{bookId}/paragraphs                   -> Paragraph
/api/v1/books/{bookId}/text                         -> CanonicalText access (signed URL)
/api/v1/books/{bookId}/analysis                     -> stage command + state
/api/v1/books/{bookId}/characters                   -> Character
/api/v1/books/{bookId}/characters/{characterId}
/api/v1/books/{bookId}/characters/{characterId}/aliases       -> CharacterAlias
/api/v1/books/{bookId}/characters/{characterId}/voice         -> voice assignment
/api/v1/books/{bookId}/character-merges             -> merge / split commands
/api/v1/books/{bookId}/story-bible                  -> StoryBible
/api/v1/books/{bookId}/story-bible/snapshots        -> NarrativeState
/api/v1/books/{bookId}/story-bible/pronunciations   -> book pronunciation lexicon
/api/v1/books/{bookId}/director                     -> stage command + state
/api/v1/books/{bookId}/audio-script                 -> current AudioScript
/api/v1/books/{bookId}/audio-scripts                -> AudioScript versions
/api/v1/books/{bookId}/audio-script-chunks          -> AudioScriptChunk
/api/v1/books/{bookId}/audio-script-chunks/{chunkId}
/api/v1/books/{bookId}/casting                      -> casting readiness (derived)
/api/v1/books/{bookId}/voice-profiles               -> VoiceProfile (book-scoped view)
/api/v1/voice-profiles                              -> VoiceProfile (tenant library)
/api/v1/voice-profiles/{voiceProfileId}
/api/v1/voice-profiles/{voiceProfileId}/versions    -> VoiceProfileVersion
/api/v1/voice-profiles/{voiceProfileId}/versions/{version}
/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/reference-audio
/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/previews
/api/v1/books/{bookId}/tts                          -> stage command + state
/api/v1/books/{bookId}/audio-chunks                 -> AudioChunk
/api/v1/books/{bookId}/audio-chunks/{audioChunkId}
/api/v1/books/{bookId}/assembly                     -> stage command + state
/api/v1/books/{bookId}/chapter-audio                -> ChapterAudio
/api/v1/books/{bookId}/chapter-audio/{chapterAudioId}
/api/v1/books/{bookId}/audiobook                    -> current Audiobook (pointer)
/api/v1/books/{bookId}/audiobooks                   -> Audiobook versions
/api/v1/books/{bookId}/audiobooks/{audiobookId}
/api/v1/books/{bookId}/audiobooks/{audiobookId}/cover
/api/v1/books/{bookId}/progress                     -> derived progress read model
/api/v1/books/{bookId}/events                       -> SSE stream
/api/v1/jobs                                        -> ProcessingJob
/api/v1/jobs/{jobId}
/api/v1/jobs/{jobId}/attempts                       -> ProcessingAttempt
/api/v1/jobs/{jobId}/cancellation                   -> cancellation command
/api/v1/jobs/{jobId}/events                         -> SSE stream
/api/v1/model-versions                              -> ModelVersion (read-only)
/api/v1/capabilities                                -> provider capability projection
/api/v1/admin/...                                   -> administrative surface
```

Every path above maps to an entity in `context.md` §4.2, to an explicitly documented
ephemeral object (the upload session, §3.2.5), or to a **derived read model** over entities
the architecture already defines. No entity is invented. The `.../access-urls`
sub-resource (§16.20) exists on every binary-bearing resource and is not repeated in the
tree above.

### 4.2 Entity to resource map

| `context.md` §4.2 entity | Owner service | Public resource | Public mutability |
| --- | --- | --- | --- |
| `User` | User | `/users/me`, `/admin/users` | Profile fields only |
| `Book` | Book | `/books`, `/books/{bookId}` | Metadata; soft delete |
| `BookFile` | Ingestion | `/books/{bookId}/files` | Created via the upload flow; never edited |
| `Chapter` | Book | `/books/{bookId}/chapters` | Title/order, state-gated (§16.7) |
| `Section` | Book | `/books/{bookId}/sections` | Read-only in v1 |
| `Scene` | Book (rows) / Context (semantics) | `/books/{bookId}/scenes` | Read-only in v1 |
| `Paragraph` | Book | `/books/{bookId}/paragraphs` | Read-only |
| `Character` | Character | `/books/{bookId}/characters` | Metadata, merge/split |
| `CharacterAlias` | Character | `.../characters/{id}/aliases` | Create/update/delete, state-gated |
| `VoiceProfile` | Voice | `/voice-profiles`, `/books/{bookId}/voice-profiles` | Metadata; lock state |
| `VoiceProfileVersion` | Voice | `.../versions` | Create, approve, lock. Never edited once `LOCKED` |
| `StoryBible` | Context | `/books/{bookId}/story-bible` | Pronunciation lexicon only |
| `NarrativeState` | Context | `.../story-bible/snapshots` | Read-only (immutable) |
| `AudioScript` | Director | `/books/{bookId}/audio-script[s]` | Read-only (immutable) |
| `AudioScriptChunk` | Director | `/books/{bookId}/audio-script-chunks` | Performance fields while `DRAFT`/`VALIDATED` only (§16.11) |
| `TTSJob` | Job / TTS | **not publicly exposed** — surfaced as `ProcessingJob` | — |
| `AudioChunk` | TTS | `/books/{bookId}/audio-chunks` | Read-only (immutable) |
| `ChapterAudio` | Assembly | `/books/{bookId}/chapter-audio` | Read-only (immutable) |
| `Audiobook` | Assembly | `/books/{bookId}/audiobook[s]` | Metadata + cover before publish; artifact immutable |
| `ProcessingJob` | Job | `/jobs` | Cancellation only |
| `ProcessingAttempt` | Job | `/jobs/{jobId}/attempts` | Read-only (immutable) |
| `ModelVersion` | Job/Platform | `/model-versions` | Read-only |

`TTSJob` (§4.2 #16) is deliberately **not** a public resource: it is the per-chunk synthesis
request record, and the public job vocabulary is `ProcessingJob` (`context.md` §25.8 — the
API does not invent a second job vocabulary). A `TTSJob` is reachable from the internal API
(§17.5) and is reflected publicly through the `AudioChunk` and its `ProcessingJob`.

### 4.3 Stage sub-resource convention (binding)

Non-CRUD work is modelled as a **singular stage sub-resource** of a book, per `context.md`
§25.1 ("actions that are not CRUD are modelled as sub-resource commands that create a job").

```
POST /api/v1/books/{bookId}/{stage}   -> validate prerequisites, persist intent,
                                         enqueue, return 202 + job handle
GET  /api/v1/books/{bookId}/{stage}   -> the current and historical run state of that stage
```

The five stages are `ingestion`, `analysis`, `director`, `tts`, and `assembly`. This is the
**only** command shape in the public API. There is no `POST /doStuff`, no RPC verb in a
path, and no second way to start the same work.

Chunk-level and chapter-level regeneration are **scoped invocations of the same stage
endpoint**, not separate endpoints (§16.15). This is what structurally guarantees
`context.md` §16.4: one contract regenerates one chunk, one chapter, or a book, and the
scope decides which children are enqueued.

Two documented exceptions, both artifact-creating rather than stage-running:

- `POST .../voice-profiles/{id}/versions/{version}/previews` — creates preview samples
  (`generate_voice_preview`), because previews are artifacts of a voice version, not a book
  stage (`context.md` §15).
- `POST /books/{bookId}/character-merges` — records a merge/split command
  (`context.md` §8.4), whose downstream re-binding is enqueued as a consequence.

---

## 5. Authentication

### 5.1 Mechanism

Per `context.md` §18.1 and §23 row 27: **self-hosted JWT/session auth, OIDC-ready**. Two
credential presentations are supported and are mutually exclusive per request:

| Presentation | Audience | Transport | CSRF |
| --- | --- | --- | --- |
| **Bearer access token** | Programmatic clients, the future mobile app, server-side rendering from `web` | `Authorization: Bearer <jwt>` | Not applicable |
| **Session cookie** | Browser | `HttpOnly`, `Secure`, `SameSite=Lax` cookie named `session` | Required on unsafe methods (§14.6) |

A request presenting both is rejected `400 AMBIGUOUS_CREDENTIALS`. Token verification
**fails closed** (`context.md` §18.1): any verification error, key-rotation gap, or
revocation-store unavailability yields `401`, never a permissive fallback.

### 5.2 Access token

Claims (`context.md` §3.2.2): `{sub, tenant_id, roles[], scopes[], exp, iat, jti, aud, iss}`.

- Signed asymmetrically (RS256/EdDSA); public keys served at the internal JWKS endpoint and
  cached with a short TTL by the gateway (`context.md` §3.2.2, Redis token-verification
  cache).
- Lifetime: **short**, on the order of minutes (`configuration`, recorded in
  `deployment-architecture.md`). Clients **MUST** treat expiry as normal and refresh.
- Revocation: `jti` is checked against the Redis revocation list. Revocation is
  authoritative even before natural expiry.
- Browser clients **MUST NOT** persist the access token to `localStorage`; browsers use the
  session-cookie path.

### 5.3 Refresh token

- Opaque, high-entropy, stored hashed at rest, and **rotating**: every successful refresh
  issues a new refresh token and invalidates the presented one.
- Reuse of an already-rotated refresh token is treated as compromise: the entire token
  family is revoked and the response is `401 REFRESH_TOKEN_REUSED`.
- Lifetime: days (`configuration`). Bound to a device/session record so it can be listed and
  revoked individually.

### 5.4 Session behavior (browser)

- The session cookie carries a server-side session identifier, not claims.
- Cookie attributes are fixed by contract: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
  and a host-scoped name. `SameSite=None` **MUST NOT** be used.
- Logout revokes the session server-side; clearing the cookie alone is never sufficient.
- Sessions are listable and individually revocable (§16.2).

### 5.5 MFA

`context.md` §18.1 requires MFA *capability*. The contract reserves it: a login attempt for
an MFA-enabled principal returns `200` with `data.status = "MFA_REQUIRED"` and an
`mfa_token` exchangeable only at `POST /api/v1/auth/mfa`. Enrolment and factor management
endpoints are **reserved and not specified in v1** (OQ-6, §24); an implementation phase
**MUST NOT** invent them.

### 5.6 Service-to-service authentication

Per `context.md` §18.1: **mTLS or signed service tokens with narrow audiences**.

- Every internal call carries a service token whose `aud` names the *specific* callee
  service and whose `scopes[]` name the specific operations (for example `job:transition`,
  `chunk:write`).
- Service tokens are short-lived, minted by the Auth Service, and **never** valid on
  `/api/v1/**`. Presenting a service token to a public endpoint is `401`; presenting a user
  token to `/internal/v1/**` is `401`. The two audiences never overlap.
- Workers carry a `worker` principal that additionally names `worker_id`, the queue set it
  consumes, and `tenant_scope = ALL` — workers are cross-tenant by necessity and therefore
  carry the strictest scope allowlist (§6.5).
- No long-lived static API keys for user auth (`context.md` §18.1). Programmatic user API
  keys are **not part of v1** (OQ-7, §24).

### 5.7 Which endpoints require authentication

| Group | Authentication |
| --- | --- |
| `POST /api/v1/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/password-reset`, `/auth/password-reset/confirm`, `/auth/mfa` | **None** (they establish it). Strictly rate-limited (§14.3). |
| Every other `/api/v1/**` endpoint | **Required.** No anonymous read of any resource. |
| `/api/v1/admin/**` | Required **and** the `PLATFORM_ADMIN` role (§6.2). |
| `/internal/v1/**` | Service or worker credential (§5.6). |
| `/health`, `/ready` | None — and not publicly routed (§19). |
| `/health/dependencies`, `/metrics` | Service credential; never publicly routed. |

There is no public, unauthenticated read path to any book, chunk, audio artifact, or job.
Signed object-storage URLs (§16.20) are the only credential-free access to bytes, and they
are minted **only after** an ownership check, are single-object and single-method, and are
short-lived (`context.md` §18.7).
---

## 6. Authorization and ownership

### 6.1 Principle

`context.md` §18.2: **every** resource access is checked against the `tenant_id` of the
authenticated principal, and the ownership check happens **in the owning service**, not only
at the gateway. Deny by default.

The gateway performs authentication and coarse scope checks. It **MUST NOT** be the only
place ownership is enforced; an implementation that satisfies ownership at the gateway alone
is a contract violation.

### 6.2 Roles

`context.md` names `roles` in the token but does not enumerate them (OQ-5, §24). This
document fixes the minimum set required to specify the endpoints below. It is **provisional
pending §27 confirmation**, and no implementation may extend it.

| Role | Scope | Meaning |
| --- | --- | --- |
| `TENANT_OWNER` | One tenant | Full control of the tenant's books, voices, jobs, members, quotas. |
| `TENANT_MEMBER` | One tenant | Read and write on resources within the tenant, subject to §6.3. |
| `PLATFORM_ADMIN` | Global | Operational administration (§16.22). Cross-tenant **metadata** access for support and incident response, audited. **Never** content access — see §6.6. |
| `SERVICE` | Internal | A named internal service (§5.6). |
| `WORKER` | Internal | A queue-consuming worker process (§5.6). |

**Project/workspace membership** appears in `context.md` §19.1 as an optional grouping that
"v1 may default to a single implicit project". This document therefore specifies a single
implicit project per tenant and **does not** define project-scoped roles or a collaboration
permission model. Collaboration is OQ-4 (§24). Until it is resolved, all `TENANT_MEMBER`
principals have equal access to the tenant's resources, and the "project/book owner" role
requested by the commissioning brief is **the tenant**, not an individual user — recorded as
conflict C-4 in §23.

### 6.3 The ownership rule

Every book-scoped resource resolves ownership by the same chain:

```
principal.tenant_id  ==  book.tenant_id  ==  resource.tenant_id
```

- `Book`, `BookFile`, `Chapter`, `Section`, `Scene`, `Paragraph`, `Character`,
  `CharacterAlias`, `StoryBible`, `NarrativeState`, `AudioScript`, `AudioScriptChunk`,
  `AudioChunk`, `ChapterAudio`, `Audiobook`, `ProcessingJob`, `ProcessingAttempt` — all
  reached only through their book, and the book only through the tenant.
- `VoiceProfile` / `VoiceProfileVersion` — tenant-scoped (`context.md` §19.1). A book-scoped
  profile additionally carries `book_id` and is reachable only through that book. See OQ-1
  (§24) for the `context.md` §4.3 vs §19.1 scope ambiguity this reconciles.
- `ProcessingJob` — `context.md` §18.2: a user may create, read, cancel, or replay only jobs
  whose **target resources** they own. A job's `tenant_id` is recorded at creation and
  checked on every access; it is never derived from the caller at read time.

There is no resource in this API that is readable without an ownership check, and no
endpoint that returns a resource belonging to a tenant other than the caller's.

### 6.4 Existence disclosure

`context.md` §25.4: `401` unauthenticated, `403` unauthorized, and **`404` where revealing
existence would leak information across tenants**. Binding resolution:

| Situation | Status | Rationale |
| --- | --- | --- |
| No or invalid credential | `401` | — |
| Valid credential, resource belongs to **another tenant** | `404` | Existence must not leak across tenants. |
| Valid credential, resource in **the caller's tenant**, caller lacks the role/scope | `403` | Existence is already known to the tenant; hiding it would be confusing, not safer. |
| Valid credential, resource does not exist | `404` | — |
| Valid credential, resource **soft-deleted**, caller owns it | `404` on normal reads; `200` with `?include_deleted=true` for `TENANT_OWNER` | §16.6. |
| Valid credential, resource **purged** | `410` | The identifier is known to have existed and been hard-deleted (§16.6). |

A `403` therefore **never** appears for a cross-tenant reference. This distinction is
testable and is a required contract test.

### 6.5 Authorization matrix by principal

| Principal | Books | Files | Jobs | Voice profiles | Audio artifacts | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| `TENANT_OWNER` | Full within own tenant | Full | Create/read/cancel/replay own tenant | Full, incl. approve and lock | Read, request regeneration | — |
| `TENANT_MEMBER` | Full within own tenant | Full | Create/read/cancel own tenant | Full, incl. approve and lock | Read, request regeneration | — |
| `PLATFORM_ADMIN` | Read **metadata** of any tenant (audited) | Metadata only | Read/cancel/replay any (audited) | Metadata only | Metadata only | Full (§16.22) |
| `SERVICE` | Per its `aud`/`scopes`; tenant carried explicitly in the call | Same | Same | Same | Same | — |
| `WORKER` | No book reads for TTS workers (`context.md` §10.1 and rule 16) | — | Transition only jobs it holds a lease on | Resolve bindings only where its role permits | Write only its own outputs | — |

Worker write surface is deliberately narrow (`context.md` §23 row 8): `AudioChunk`,
`AudioScriptChunk`, `ProcessingAttempt`, and Story Bible deltas. The internal API (§17)
exposes nothing beyond that, and a worker token's scopes are the enforcement.

### 6.6 Administrator content boundary

`PLATFORM_ADMIN` **MUST NOT** be able to read book text, canonical text, Story Bible
content, or audio bytes, and **MUST NOT** be able to mint signed URLs for tenant artifacts,
through any endpoint in this specification. `context.md` §18.11 (copyright, per-tenant
storage, no cross-tenant sharing) and §19.2 ("no cross-tenant read is possible through any
API path") make administrative content access an explicit non-feature. Administrative
endpoints return **metadata, lineage, state, and diagnostics only**, and every access is
written to the audit log.

### 6.7 Ownership enforcement is not optional

For every endpoint in §16, the "Authorization" line states the exact rule. An endpoint whose
authorization line is missing, or reads "implicit", is a defect in this document. There is
no endpoint in this API whose ownership behavior is implicit.

---

## 7. Response conventions

### 7.1 Single resource

```json
{
  "data": {
    "id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "object": "book",
    "created_at": "2026-08-27T11:04:03.221Z",
    "updated_at": "2026-08-27T11:20:11.004Z"
  }
}
```

- `data` is always an object for single-resource responses.
- Every resource carries `id` and `object` — a stable, lowercase, singular type name:
  `book`, `book_file`, `upload_session`, `chapter`, `section`, `scene`, `paragraph`,
  `character`, `character_alias`, `story_bible`, `narrative_state`, `voice_profile`,
  `voice_profile_version`, `voice_preview`, `audio_script`, `audio_script_chunk`,
  `audio_chunk`, `chapter_audio`, `audiobook`, `job`, `job_attempt`, `model_version`,
  `user`.
- `created_at` and `updated_at` appear on every persisted resource (`context.md` §4.1).
  Immutable resources report `updated_at == created_at`.

### 7.2 Collection

```json
{
  "data": [ { "id": "...", "object": "chapter" } ],
  "page": {
    "limit": 25,
    "next_cursor": "eyJrIjoiMDFKOVoySzdRMFY2WThCM000TjVQNlI3UzgifQ",
    "prev_cursor": null,
    "has_more": true,
    "total": null
  }
}
```

`context.md` §25.3 fixes the collection envelope as `data[]` plus
`page: { next_cursor, has_more, limit }`. This document adds `prev_cursor` and `total`, both
**always present and nullable**, which is additive and therefore permitted (§22.2).

> **Deviation notice.** The brief that commissioned this document illustrated the collection
> envelope with a `"pagination"` key. `context.md` §25.3 names it `page`, and `context.md`
> is Tier 0. The contract is `page`. Recorded as conflict C-1 in §23.

### 7.3 Asynchronous operation

Every stage command and every job-creating endpoint returns the same shape:

```json
{
  "data": {
    "job": {
      "id": "01J9Z3A1B2C3D4E5F6G7H8J9K0",
      "object": "job",
      "type": "generate_tts_chunk",
      "status": "QUEUED",
      "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
      "created_at": "2026-08-27T11:04:03.221Z",
      "links": { "self": "/api/v1/jobs/01J9Z3A1B2C3D4E5F6G7H8J9K0" }
    },
    "accepted": {
      "scope": "CHAPTERS",
      "chapter_ids": ["01J9Z4CH0000000000000001"],
      "planned_unit_count": 412,
      "skipped_unit_count": 1188,
      "skip_reason": "EXISTING_VALID_OUTPUT_FOR_LINEAGE"
    }
  }
}
```

Binding rules:

1. The HTTP status is `202 Accepted` — never `200`, never `201` (§9.1).
2. `data.job.status` on acceptance is `CREATED`, `QUEUED`, or `BLOCKED` only. It is **never**
   `RUNNING`, `SUCCEEDED`, or any value implying that the work happened (`context.md` §25.8).
3. `accepted` describes **what was admitted**, not what was produced. It **MUST NOT** name
   artifact identifiers that do not yet exist.
4. `planned_unit_count` and `skipped_unit_count` reflect the resumability skip logic of
   `context.md` §16.5 and are the honest basis for progress math.
5. A response body **MUST NOT** state or imply completion. `"status": "SUCCEEDED"` inside a
   `202` response is a contract violation.

### 7.4 Empty and no-content responses

- `204 No Content` carries no body at all — not `{"data": null}`.
- A collection with no matches is `200` with `data: []` and `page.has_more: false`, never
  `404`.

### 7.5 Links

Resources carry a `links` object with, at minimum, `self`. Job-bearing resources carry
`links.job`; artifact-bearing resources carry `links.access_urls` (§16.20). Links are
relative paths beginning `/api/v1/`. Clients **SHOULD** follow links rather than
constructing paths, but the paths in this document are stable and may be constructed.

### 7.6 Enum forward-compatibility

New enum **members** may be added within `v1` for any field whose vocabulary `context.md`
does not close (`context.md` §27.4, change class "Additive"). Clients **MUST** tolerate an
unknown enum value by treating it as unrecognized, and **MUST NOT** crash or coerce it.

Vocabularies that `context.md` **closes** — job states (§16.1), book lifecycle states
(§4.4), `AudioScriptChunk` and `AudioChunk` states (§4.4), voice approval states (§9.2),
and the emotion / delivery-mode / pacing vocabularies (§6.3) — are **not** extensible within
`v1`. Adding a member there is a Breaking change requiring §27 approval and a version bump.

### 7.7 Partial and degraded responses

Some reads are explicitly allowed to succeed while incomplete (`context.md` §3.2.10). Those
responses are `200` and carry, at the top level of `data`:

```json
{ "degraded": true, "degraded_reasons": ["CONTEXT_LAYER_UNAVAILABLE:L2"] }
```

`degraded` is `false` on a complete response and is **always present** on endpoints where
degradation is possible (story bible reads, progress reads, capability reads). Degradation
is never signalled by a `5xx`, and never by silently omitting data.

---

## 8. Error contract

### 8.1 The single envelope

Exactly one error shape, on every endpoint, in every layer, from every service
(`context.md` §25.6):

```json
{
  "error": {
    "code": "VOICE_PROFILE_LOCKED",
    "message": "This voice profile version is locked because it has produced retained audio. Create a new version instead.",
    "details": [
      { "field": "base_generation_params.speed", "issue": "immutable_after_lock" }
    ],
    "request_id": "01J9Z3REQ0000000000000000",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "retryable": false,
    "documentation_url": "https://docs.example.com/api/errors/VOICE_PROFILE_LOCKED"
  }
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `code` | string | Yes | Stable, documented, machine-readable. `SCREAMING_SNAKE_CASE`. Never localised, never reworded. |
| `message` | string | Yes | Human-readable, safe to display, and it says **what to do next** (`context.md` §21 cross-cutting invariants). |
| `details` | array of objects | Yes (may be `[]`) | Field-scoped issues: `{ field, issue, ... }`. **Always an array**, never an object. |
| `request_id` | string | Yes | Matches the `X-Request-Id` response header. |
| `trace_id` | string | Yes | Matches the `X-Trace-Id` response header. |
| `retryable` | boolean | Yes | Whether an identical retry could plausibly succeed. Mirrors the retryable/terminal distinction of `context.md` §11.4. |
| `documentation_url` | string | Yes | Stable per code. |

> **Deviation notice.** The commissioning brief illustrated `details` as an object (`{}`).
> `context.md` §25.6 defines it as an array of `{field, issue}` and adds `trace_id`,
> `retryable`, and `documentation_url`. The contract follows `context.md`. Recorded as
> conflict C-2 in §23.

### 8.2 What an error MUST NOT contain

- Stack traces, exception class names, file paths, line numbers, SQL, queue names, Redis
  keys, object-storage keys, bucket names, internal hostnames, or model prompt text.
- Signed URLs (`context.md` rule 20 — never log or leak them).
- Book text, canonical text, or Story Bible content beyond the minimal span needed to
  identify a validation failure — and never at all in an authentication or authorization
  error.
- Any indication that a resource exists in another tenant (§6.4).

Internal diagnostics are correlated by `request_id` and `trace_id` and are available to
operators only (`context.md` §17.5).

### 8.3 Error code conventions

- `SCREAMING_SNAKE_CASE`, stable forever within `v1`. Renaming a code is a Breaking change
  (`context.md` §27.4) requiring §27 approval.
- Codes are owned by the **shared error taxonomy in the contracts package** (`context.md`
  §25.6, §22.4). The registry in §21 is the API-facing projection of that taxonomy: the
  taxonomy owns the identifier strings, this document owns their HTTP mapping.
- Shape: `{DOMAIN}_{CONDITION}` where the domain is an entity or concern
  (`BOOK_NOT_FOUND`, `VOICE_PROFILE_LOCKED`, `IDEMPOTENCY_KEY_CONFLICT`,
  `AUDIO_SCRIPT_CHUNK_FROZEN`). Generic conditions may omit the domain
  (`VALIDATION_FAILED`, `RATE_LIMITED`).
- One code, one meaning, one HTTP status. A code **MUST NOT** map to two statuses.

### 8.4 Error classes and their mapping

| Class | HTTP | Representative codes | `retryable` |
| --- | --- | --- | --- |
| **Validation** | `422` | `VALIDATION_FAILED`, `UNSUPPORTED_FILE_FORMAT`, `INVALID_CURSOR`, `INVALID_SORT_FIELD` | `false` |
| **Malformed request** | `400` | `MALFORMED_JSON`, `MISSING_IDEMPOTENCY_KEY`, `AMBIGUOUS_CREDENTIALS` | `false` |
| **Authentication** | `401` | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `REFRESH_TOKEN_REUSED`, `MFA_REQUIRED` | `false` |
| **Authorization** | `403` | `FORBIDDEN`, `INSUFFICIENT_SCOPE`, `ADMIN_CONTENT_ACCESS_DENIED` | `false` |
| **Not found / hidden** | `404` | `BOOK_NOT_FOUND`, `JOB_NOT_FOUND`, `CHUNK_NOT_FOUND`, `RESOURCE_NOT_FOUND` | `false` |
| **Gone** | `410` | `RESOURCE_PURGED` | `false` |
| **Conflict / state** | `409` | `VOICE_PROFILE_LOCKED`, `AUDIO_SCRIPT_CHUNK_FROZEN`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_CONFLICT`, `RESOURCE_VERSION_CONFLICT`, `DUPLICATE_CONTENT_HASH` | `false` |
| **Precondition / gate** | `409` | `CASTING_INCOMPLETE`, `INGESTION_NOT_COMPLETE`, `AUDIO_SCRIPT_NOT_VALIDATED`, `CHAPTER_MANIFEST_INCOMPLETE` | `false` until the gate is satisfied |
| **Payload too large** | `413` | `REQUEST_TOO_LARGE`, `FILE_TOO_LARGE` | `false` |
| **Unsupported media** | `415` | `UNSUPPORTED_MEDIA_TYPE` | `false` |
| **Quota / limit** | `429` | `RATE_LIMITED`, `QUOTA_EXCEEDED`, `CONCURRENCY_LIMIT_REACHED` | `true` after `Retry-After` |
| **Processing** | `409` or `422` | `PARSE_FAILED`, `DIRECTOR_VALIDATION_FAILED`, `AUDIO_VALIDATION_FAILED`, `VOICE_CONSISTENCY_VIOLATION` | `false` |
| **Infrastructure** | `500` / `502` / `503` | `INTERNAL_ERROR`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `DEPENDENCY_DEGRADED` | `true` |

Processing failures of *already-accepted asynchronous work* are **not** HTTP errors. They
appear as job state (`FAILED`, `DEAD_LETTERED`) with a typed `error` object on the job and
its attempts (§16.18). An endpoint **MUST NOT** return `200` carrying a failure
(`context.md` §25.6) and **MUST NOT** return `5xx` because a background job failed.

### 8.5 Validation error detail shape

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body failed validation.",
    "details": [
      { "field": "title", "issue": "too_long", "constraint": { "max_length": 512 } },
      { "field": "language", "issue": "invalid_format", "constraint": { "format": "BCP-47" } },
      { "field": "authorr", "issue": "unknown_field" }
    ],
    "request_id": "01J9Z3REQ0000000000000000",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "retryable": false,
    "documentation_url": "https://docs.example.com/api/errors/VALIDATION_FAILED"
  }
}
```

- `field` uses dotted/bracketed JSON paths (`chapters[3].title`, `metadata.series.name`).
- `issue` values come from a closed set: `required`, `unknown_field`, `invalid_type`,
  `invalid_enum`, `invalid_format`, `too_long`, `too_short`, `out_of_range`, `not_found`,
  `not_owned`, `immutable`, `immutable_after_lock`, `duplicate`, `inconsistent_with`.
- `details` **MUST** list every failing field, not only the first.
- `details` **MUST NOT** echo the rejected value for secret-bearing fields (passwords,
  tokens, consent attestations).

---

## 9. HTTP status codes

### 9.1 When each status is used

| Status | Used for | Never used for |
| --- | --- | --- |
| `200 OK` | Successful `GET`; successful `PATCH`/`PUT` returning the updated resource; a synchronous command that fully completed (cancellation, approval, lock) | Anything asynchronous |
| `201 Created` | A resource that now exists and is fully usable: `POST /books`, `POST /voice-profiles`, `POST .../versions`, `POST .../aliases`, `POST .../upload-sessions`. `Location` header required | Anything that only enqueued work |
| `202 Accepted` | **Every** stage command and every job-creating endpoint (§7.3). `Location` points at the job | A synchronous success |
| `204 No Content` | Successful `DELETE`; a successful action with nothing to return | Any response carrying a body |
| `206 Partial Content` | Range responses — emitted by **object storage**, not by this API (§16.20) | — |
| `304 Not Modified` | Conditional `GET` with a matching `ETag` | — |
| `400 Bad Request` | Malformed syntax: unparseable JSON, missing required header, contradictory credentials | Field-level validation (that is `422`) |
| `401 Unauthorized` | Missing, malformed, expired, or revoked credential | A valid credential lacking permission |
| `403 Forbidden` | Valid credential, insufficient role/scope, resource **within the caller's tenant** | Cross-tenant references (that is `404`) |
| `404 Not Found` | Unknown resource, cross-tenant resource, soft-deleted resource on a normal read | Hiding a permission failure inside the tenant |
| `405 Method Not Allowed` | A method the resource never supports (`PATCH` on `AudioChunk`) | A method forbidden by current *state* (that is `409`) |
| `409 Conflict` | State conflicts, immutability violations, unmet prerequisites, idempotency-key conflicts, duplicate content | Field-shape validation |
| `410 Gone` | A purged resource whose identifier is known to have existed and been hard-deleted | Soft-deleted resources (`404`) |
| `413 Content Too Large` | Request body above the API limit; declared upload size above the format limit | An upload exceeding its size *during transfer* (that is an upload-session failure, §16.6) |
| `415 Unsupported Media Type` | Non-JSON `Content-Type` on a JSON endpoint | A disallowed *file* format (that is `422 UNSUPPORTED_FILE_FORMAT`) |
| `422 Unprocessable Content` | Semantic or field validation failure on a well-formed body | Syntax errors |
| `429 Too Many Requests` | Rate limit, quota, concurrency cap. `Retry-After` required | Backpressure that should instead queue (§14.3) |
| `500 Internal Server Error` | Unhandled server fault. Body is the standard envelope with `INTERNAL_ERROR` | A background job failure |
| `502 Bad Gateway` | An upstream internal service returned an unusable response | A dependency that is merely slow |
| `503 Service Unavailable` | A required dependency is unavailable, or the service is draining. `Retry-After` required (`context.md` §3.2.1) | Degraded-but-working states, which return `200` with `degraded: true` (§7.7) |

`501` is not used. `307` and `308` are not used by `/api/v1/**`.

### 9.2 `405` versus `409`

The distinction is contractual and testable:

- **`405`** — the resource *never* supports the method. `PATCH /books/{id}/audio-chunks/{id}`
  is always `405`: `AudioChunk` is immutable by architecture (`context.md` §2.5, §4.5).
- **`409`** — the resource supports the method, but its **current state** forbids it.
  `PATCH /books/{id}/audio-script-chunks/{id}` on a frozen chunk is
  `409 AUDIO_SCRIPT_CHUNK_FROZEN`, because the same call on a `DRAFT` chunk succeeds
  (`context.md` §7.3).

### 9.3 `202` is not a promise

`202 Accepted` means exactly: *the request was validated, intent was persisted, work was
enqueued, and a job handle exists.* It asserts nothing about the work. `context.md` §25.8
and §2.3 make this binding, and §13 restates the full chain.
---

## 10. Pagination, filtering, and sorting

### 10.1 Pagination strategy

**Cursor pagination is the default and is used by every collection endpoint in this
document** (`context.md` §25.3). Offset pagination is not offered: chunk, job, and paragraph
collections are large and actively mutating while a book renders, and offset paging over a
mutating set silently skips and duplicates rows.

| Parameter | Type | Default | Max | Meaning |
| --- | --- | --- | --- | --- |
| `limit` | integer | `25` | `100` | Items per page. `limit` above the maximum is `422 VALIDATION_FAILED`, never silently clamped. |
| `cursor` | string | — | — | Opaque forward cursor from `page.next_cursor`. |
| `before` | string | — | — | Opaque backward cursor from `page.prev_cursor`. Mutually exclusive with `cursor`. |
| `include_total` | boolean | `false` | — | Requests `page.total`. Expensive; may be refused with `page.total: null` on very large collections. |

### 10.2 Cursor format

- The cursor is an **opaque, URL-safe base64 string**. Clients **MUST NOT** decode,
  construct, modify, or persist cursors beyond the life of a listing session.
- It encodes the sort key of the last returned row plus a tiebreaker on `id`, and a
  fingerprint of the filter and sort parameters it was issued for.
- Presenting a cursor with a **different** filter or sort than it was issued for is
  `422 INVALID_CURSOR`. Cursors are not portable between queries.
- A malformed, tampered, or expired cursor is `422 INVALID_CURSOR`. Cursors expire after a
  bounded window (`configuration`).
- Cursors are **tenant-bound**: a cursor issued to one tenant is invalid for another and
  yields `422 INVALID_CURSOR`, never data.

### 10.3 Ordering

- Every collection has a **documented default order**, and it is stable: a total order is
  always achieved by appending `id` as the final tiebreaker.
- Default orders:

| Collection | Default order |
| --- | --- |
| `/books` | `created_at:desc` |
| `/books/{bookId}/chapters`, `/sections`, `/scenes`, `/paragraphs` | `order_index:asc` (reading-spine order) |
| `/books/{bookId}/audio-script-chunks` | `sequence_index:asc` |
| `/books/{bookId}/audio-chunks` | `sequence_index:asc`, then `generation_version:desc` |
| `/books/{bookId}/characters` | `importance_rank:asc` |
| `/voice-profiles`, `/books/{bookId}/voice-profiles` | `name:asc` |
| `/jobs` | `created_at:desc` |
| `/jobs/{jobId}/attempts` | `attempt_number:asc` |
| `/books/{bookId}/audiobooks`, `/chapter-audio` | `version:desc` |
| `/books/{bookId}/story-bible/snapshots` | `spine_position:asc` |

- Sorting is requested as `sort=field:asc` or `sort=field:desc` (`context.md` §25.3).
- Only **allowlisted, indexed** fields are sortable. A field outside the allowlist is
  `422 INVALID_SORT_FIELD` naming the permitted fields in `details`.
- Only **one** sort parameter is accepted. Multi-field sorting is not offered in v1.

### 10.4 Filtering

Filtering uses explicit, allowlisted query parameters (`context.md` §25.3). There is **no**
free-form query language, no `filter[...]` bracket syntax, no client-supplied SQL or
expression fragments, and no per-endpoint bespoke syntax.

| Convention | Rule |
| --- | --- |
| Equality | `?status=FAILED` |
| Multi-value (OR within one field) | Repeat or comma-separate: `?status=FAILED,DEAD_LETTERED`. Maximum 20 values (`configuration`). |
| Multiple fields | Combined with AND: `?status=FAILED&chapter_id=...` |
| Time ranges | `?created_after=`, `?created_before=` — RFC 3339, inclusive of the bound |
| Booleans | `true` / `false`, lowercase only |
| Soft-deleted | `?include_deleted=true` — `TENANT_OWNER` only, and only on `/books` |
| Superseded versions | `?include_superseded=true` on version-bearing collections; default `false` |

An unknown or non-allowlisted query parameter is **rejected** with
`422 VALIDATION_FAILED` and `details[].issue = "unknown_field"`. Silently ignoring an
unknown filter is forbidden: it would return a wider result set than the client believes it
asked for.

### 10.5 The standard query vocabulary

These names mean the same thing on every endpoint that supports them, and no endpoint may
use them for anything else:

```
?status=      resource or job state, from the vocabulary in §20
?type=        job type (§20.3) or resource subtype
?sort=        field:asc | field:desc
?limit=       page size
?cursor=      forward cursor
?before=      backward cursor
?chapter_id=  scope to one chapter
?scene_id=    scope to one scene
?character_id= scope to one character
?book_id=     scope to one book (top-level collections only, e.g. /jobs)
?include_total=      request page.total
?include_superseded= include superseded versions
?include_deleted=    include soft-deleted rows
?created_after= / ?created_before=   time window
```

---

## 11. Idempotency

### 11.1 Where idempotency is required

`context.md` §25.7 makes the `Idempotency-Key` header mandatory for upload finalization, job
creation, generation start, voice version creation, and assembly requests. Applied to this
API's endpoints:

| Operation | Endpoint | `Idempotency-Key` |
| --- | --- | --- |
| Create book | `POST /books` | **Required** |
| Create upload session | `POST /books/{bookId}/upload-sessions` | **Required** |
| Finalize upload | `POST /books/{bookId}/upload-sessions/{sessionId}/completion` | **Required** |
| Start ingestion | `POST /books/{bookId}/ingestion` | **Required** |
| Start analysis | `POST /books/{bookId}/analysis` | **Required** |
| Start Director | `POST /books/{bookId}/director` | **Required** |
| Start TTS (any scope, including chunk regeneration) | `POST /books/{bookId}/tts` | **Required** |
| Start assembly | `POST /books/{bookId}/assembly` | **Required** |
| Create voice profile version | `POST /voice-profiles/{id}/versions` | **Required** |
| Upload reference audio (create + finalize) | `POST /voice-profiles/{id}/versions/{v}/reference-audio[/completion]` | **Required** |
| Generate voice preview | `POST /voice-profiles/{id}/versions/{v}/previews` | **Required** |
| Merge or split characters | `POST /books/{bookId}/character-merges` | **Required** |
| Create voice profile | `POST /voice-profiles` | Optional (accepted and honored) |
| Create alias | `POST .../characters/{id}/aliases` | Optional (accepted and honored) |
| Mint an access URL | `POST .../access-urls` | Not applicable — see §11.6 |
| Cancel a job | `POST /jobs/{jobId}/cancellation` | Not applicable — naturally idempotent (§16.18) |
| Any `GET`, `PATCH`, `PUT`, `DELETE` | — | Not applicable — already idempotent by method |

A required-but-missing key is `400 MISSING_IDEMPOTENCY_KEY`. The API **MUST NOT** silently
proceed without one.

### 11.2 Key format and scope

- **Format:** a client-generated string, 16–128 characters, from `[A-Za-z0-9_-]`. A UUIDv4
  or ULID is the recommended value. A malformed key is `422 VALIDATION_FAILED`.
- **Scope:** the key is unique within the tuple `(tenant_id, principal_id, method, path
  template)`. The same key on a different endpoint is a different key. Keys are never
  global.
- **Binding:** the server stores the key together with a hash of the **canonicalized request
  body and the resolved path parameters**.
- **Retention:** at least 24 hours (`configuration`, recorded in
  `deployment-architecture.md`), and never shorter than the longest retry horizon of the job
  the request creates (`context.md` §16.3). Retention is enforced by the Job Service's
  idempotency-key registry (`context.md` §3.2.11).

### 11.3 Duplicate request behavior

| Situation | Behavior |
| --- | --- |
| Same key, **same** body hash, original request completed | Replay the **stored original response** verbatim — same status, same body, same `Location`. No new work. Response carries `Idempotent-Replay: true`. |
| Same key, **same** body hash, original request still in flight | `409 IDEMPOTENCY_KEY_IN_PROGRESS` with `Retry-After`. The client retries; it never receives a partial result. |
| Same key, **different** body hash | `409 IDEMPOTENCY_KEY_CONFLICT`. The stored response is not returned, and no new work is started. |
| Key expired from the registry | Treated as a new request. Server-side job idempotency (§11.4) still prevents duplicate work. |

The replayed response is byte-identical to the original, including the `job.id`. A client
retrying a `POST /books/{bookId}/tts` after a network timeout therefore receives the same job
handle rather than starting a second render.

### 11.4 Two layers of idempotency

HTTP-level idempotency (`Idempotency-Key`) protects against duplicate **requests**.
Job-level idempotency (`context.md` §16.3) protects against duplicate **work**, and it holds
even when no header was sent:

```
parse:{book_file_id}:{parser_version}
director:{chunk_scope_id}:{content_hash}:{director_version}:{context_bundle_hash}
tts:{audio_script_chunk_id}:{voice_profile_version}:{tts_model_version}:{params_hash}
assemble_chapter:{chapter_id}:{ordered_chunk_manifest_hash}
```

Enqueueing an existing key that is `RUNNING` or `SUCCEEDED` returns the existing job handle
and performs no work (`context.md` §16.3). Consequently, a stage command whose entire scope
is already satisfied still returns `202` with a job handle — the *existing* one — and
`accepted.planned_unit_count: 0`. It **MUST NOT** return `200`, `204`, or `409`: the request
was accepted, and nothing needed doing.

Job-level idempotency keys are **server-derived and never client-supplied**. A client cannot
influence, forge, or read them; they appear on the job resource only as an opaque
`idempotency_fingerprint` for support correlation.

### 11.5 Force regeneration

`context.md` §2.4 permits regeneration on an explicit force-regenerate request. Stage
commands accept `"force": true`, which:

- bypasses the *skip-existing-output* logic (`context.md` §16.5) but **not** the
  `Idempotency-Key` check;
- produces **new artifact versions** with `supersedes` pointers — it never overwrites
  (`context.md` §2.5);
- is recorded on the job as `forced: true` with the requesting principal, because a forced
  re-render is a cost event.

`force` combined with a previously used `Idempotency-Key` and an identical body is still a
replay, not a second forced run.

### 11.6 Access-URL minting is deliberately not idempotent

`POST .../access-urls` mints a fresh short-lived credential on every call by design
(`context.md` §18.7): reusing a previously issued URL would extend its effective lifetime.
The operation is *safe* in the domain sense — it changes no resource state — but it is not
replayable, and it does not accept `Idempotency-Key`. Each call is audited.

---

## 12. Request validation

### 12.1 Where validation happens

Two layers, both mandatory (`context.md` §3.2.1, §25.5):

1. **Gateway — shape only.** Content type, body size, header presence, JSON well-formedness,
   identifier format, and the declared schema of the body. No business rules, no database.
2. **Owning service — semantics and ownership.** Existence, tenancy, state preconditions,
   cross-field consistency, quota, and every rule that requires reading persisted state.

A request rejected at layer 1 never reaches layer 2, and a request that passes layer 1 is
still fully re-validated at layer 2. The gateway's validation is a filter, never a
substitute.

### 12.2 Universal rules

| Rule | Behavior on violation |
| --- | --- |
| Body must be valid JSON when `Content-Length > 0` | `400 MALFORMED_JSON` |
| Unknown fields rejected (strict mode, `context.md` §25.5) | `422 VALIDATION_FAILED` / `unknown_field` |
| Required fields present and non-null | `422` / `required` |
| Types exactly as specified (no coercion: `"5"` is not `5`) | `422` / `invalid_type` |
| Enum values from the closed vocabulary (§20) | `422` / `invalid_enum` |
| Identifiers well-formed UUIDv7/ULID | `422` / `invalid_format` |
| Identifiers exist **and** are owned by the caller's tenant | `404` (cross-tenant), or `422` / `not_found` when the id is a body field referencing a sibling resource |
| String length within bounds | `422` / `too_long`, `too_short` |
| Numeric range within bounds | `422` / `out_of_range` |
| Array length within bounds | `422` / `too_long` |
| Nesting depth within bounds | `400 MALFORMED_JSON` |
| Body size within the endpoint limit | `413 REQUEST_TOO_LARGE` |

### 12.3 Standard field constraints

Applied wherever these field names appear:

| Field | Constraint |
| --- | --- |
| `title` | 1–512 characters after trimming; no control characters |
| `author` | 0–512 characters |
| `description` | 0–8192 characters |
| `name` (voice profile, character) | 1–200 characters |
| `language` | BCP-47 tag, validated against the tag grammar |
| `content_hash` | lowercase hex, fixed length for the configured hash algorithm |
| `sequence_index`, `order_index` | integer, `>= 0` |
| `intensity`, `confidence` | float `0.0`–`1.0`, quantized to the documented step (`director-specification.md`) |
| `pacing`, `pitch`, `volume` | float within the bounded range defined in `director-specification.md` |
| `duration_ms` | integer, `>= 0` |
| `limit` | integer `1`–`100` |
| free-text user fields | rejected if they contain control characters other than `\n` and `\t`; never interpreted as markup |

### 12.4 File and upload constraints

Declared at upload-session creation and enforced again during transfer (§16.6, `context.md`
§18.3):

| Constraint | Rule |
| --- | --- |
| Formats | PDF, EPUB, and image sets (PNG/JPEG/TIFF) for scanned books (`context.md` §1.1, §3.2.6) |
| Declared MIME | Must be in the allowlist **and** agree with the sniffed magic bytes |
| Extension | Must be in the allowlist and agree with both of the above |
| Declared size | `> 0` and within the per-format maximum (`configuration`) |
| Actual size | Hard byte-count enforcement during transfer, not just the declared header |
| Checksum | Client declares the content hash; the server verifies it after transfer and rejects on mismatch |
| Structural sanity | Per-format check (page count, EPUB spine present, zip expansion ratio, entry count, image dimensions) |
| Malware scan | Mandatory before admission; failure quarantines the object |
| Reference audio | Audio formats allowlist, duration bounds, and a **consent attestation** (`context.md` §9.3.6) |
| Cover art | Image allowlist, dimension and size bounds, EXIF stripped on ingest |

### 12.5 LLM-generated metadata is validated before it persists

`context.md` §18.10 defines the mandatory chain, and it applies to every artifact that
reaches this API:

```
schema -> enumeration -> referential integrity -> range/bounds -> coverage/overlap
      -> text-hash fidelity -> confidence thresholds -> VALIDATED
```

Consequences for the API contract:

- No endpoint returns Director output that has not passed this chain, except explicitly:
  `GET /books/{bookId}/audio-script-chunks?state=DRAFT` returns pre-validation chunks with
  `state: "DRAFT"` and `validation.status: "PENDING"` clearly set.
- `character_id`, `voice_profile_id`, `scene_id`, and every offset in generated content are
  verified to resolve to an existing entity **owned by the same book** before persistence
  (`context.md` §18.9 rule 4). The API never returns a reference that failed this check.
- `text` fields are hash-verified against the source paragraphs (`context.md` §18.9 rule 5).
  A mismatch is a validation failure recorded on the chunk, never a silently served value.
- Model output is never used to construct storage keys, queries, or URLs
  (`context.md` §18.9 rule 6), so no API response contains a path or key derived from an LLM.

### 12.6 User-supplied text is untrusted

Free-text fields the user controls — book title, character name, voice profile name,
pronunciation lexicon entries, chapter titles — are stored as data and **never**:

- interpreted as markup or rendered as HTML without escaping;
- used to construct object-storage keys (`context.md` §18.5 — keys are built from validated
  identifiers only, and upload filenames are stored as metadata, never as keys);
- embedded into an LLM instruction region (they enter labelled user-content regions only,
  `context.md` §18.9 rule 1);
- used to build a query, a queue name, or a file path.

---

## 13. The API to Job to Event relationship

### 13.1 The chain

```
HTTP API request
   |  validate (shape, ownership, state preconditions, quota)
   v
Create ProcessingJob      (persisted intent + idempotency key)
   |
   v
Enqueue on the named queue (BullMQ)
   |
   v
Worker consumes, leases, heartbeats
   |
   v
Persist state + artifact   (PostgreSQL + object storage)
   |
   v
Emit event                 (job.*, book.*, tts.*, ...)
   |
   v
Frontend observes state    (poll GET /jobs/{jobId} or subscribe to SSE)
```

### 13.2 Binding consequences for this API

1. **No HTTP handler performs the work.** `context.md` §2.3 hard rule: no request handler may
   invoke an LLM, a TTS model, FFmpeg, or an OCR engine inline. Every endpoint in §16 that
   would require one returns `202` with a job handle.
2. **Acceptance is not completion.** `202` means the job exists (§9.3). The API never claims
   an outcome it has not observed.
3. **Job state is read from persisted state, never from a worker.** `context.md` §3.2.11: the
   Job Service is the sole authority on job state, and the queue is a cache of it. No public
   endpoint reads Redis or a worker to answer a status question.
4. **Progress is computed from completed units, never from wall clock** (`context.md` §11.4).
   ETA fields carry an explicit confidence and may be `null`; a fabricated ETA is a contract
   violation.
5. **Events do not command.** Public clients observe events; they never publish them. There is
   no public endpoint that emits a domain event directly (`context.md` §11.3).
6. **Event names in API payloads come from `context.md` §11.3 only.** The `type` field of an
   SSE message and the `event` field on a job history entry **MUST** be a name from that
   list. The API invents no event names; `event-contracts.md` owns their schemas.
7. **Job type names come from `context.md` §11.2 only** (§20.3). The API invents no job types.

### 13.3 Job creation is the only way work starts

There is no endpoint that performs expensive work without creating a `ProcessingJob`, and no
`ProcessingJob` that a user can create except through a stage command or a documented
artifact-creating exception (§4.3). This means the job list of a book is a complete, auditable
record of everything the user asked the system to do.

### 13.4 What the client is expected to do

```
POST /api/v1/books/{bookId}/tts            -> 202 { data.job.id }
GET  /api/v1/jobs/{jobId}                  -> poll, or
GET  /api/v1/books/{bookId}/events         -> subscribe (SSE)
GET  /api/v1/books/{bookId}/progress       -> aggregate view for the book
GET  /api/v1/books/{bookId}/audio-chunks?status=FAILED  -> inspect failures
POST /api/v1/books/{bookId}/tts            -> re-scope to the failed chunks and retry
```

The same stage endpoint starts the work and retries the failed subset. There is no separate
retry endpoint, because a retry is a scoped generation request (§16.15).

---

## 14. Security requirements

Uploaded documents and LLM-generated content are **untrusted input** (`context.md` §18).
Every requirement below is a contract obligation of the API surface, not a suggestion.

### 14.1 Authentication and authorization

Specified in §5 and §6. Summary of the non-negotiables: fail closed on token verification;
ownership checked in the owning service; deny by default; `404` rather than `403` across
tenants; no anonymous access to any resource; no cross-tenant read through any path.

### 14.2 Transport and CORS

- HTTPS only; HSTS enabled; plain HTTP refused, not redirected.
- **CORS**: an explicit origin allowlist (`configuration`). `Access-Control-Allow-Origin`
  is never `*` on any authenticated route, and `Access-Control-Allow-Credentials: true` is
  set only for allowlisted origins. Allowed methods and headers are enumerated, not
  wildcarded. Preflight results are cached for a bounded period.
- Public API responses are `Cache-Control: no-store` by default. Only `/api/v1/capabilities`
  and `/api/v1/model-versions` may be cacheable, and then only privately.

### 14.3 Rate limiting and quotas

Per `context.md` §18.6, limits apply per-IP, per-user, and per-tenant, with **separate,
stricter limits on expensive operations**:

| Bucket | Applies to |
| --- | --- |
| `auth` | `/auth/login`, `/auth/register`, `/auth/password-reset`, `/auth/mfa` — strictest; also subject to progressive delay and lockout |
| `read` | All `GET` endpoints |
| `write` | `POST`/`PATCH`/`DELETE` on metadata |
| `upload` | Upload-session creation and finalization |
| `expensive` | `POST .../ingestion`, `.../analysis`, `.../director`, `.../tts`, `.../assembly`, `.../previews` |
| `access_url` | `POST .../access-urls` |
| `stream` | SSE connections, additionally capped by concurrent connections per principal |

Exceeding a limit is `429` with `Retry-After` and the `RateLimit-*` headers, **never** a
silent drop and never a dropped job (`context.md` §18.6, §20.5). Quota exhaustion
(concurrent books, GPU-minutes, storage) is `429 QUOTA_EXCEEDED` at job-creation time —
admission control, not mid-render failure.

Backpressure from a deep GPU queue does **not** produce an HTTP error: the job is accepted
and reports its queue position (`context.md` §20.5). Rejecting user work because the fleet
is busy is a contract violation.

### 14.4 Request size limits

| Surface | Limit |
| --- | --- |
| JSON request body | Small, on the order of a few hundred kilobytes (`configuration`); exceeded is `413 REQUEST_TOO_LARGE` |
| Batch arrays in a body (chapter ids, chunk ids) | Bounded item count (`configuration`); exceeded is `422` / `too_long` |
| URL length and query-parameter count | Bounded; exceeded is `414`-equivalent, reported as `400` with `MALFORMED_JSON`-class detail |
| File bytes | **Never** traverse the API (§2.2) |

### 14.5 Upload security

The full ordered chain of `context.md` §18.3 is a precondition of admission, and this API
exposes it as upload-session state (§16.6): authenticated session → tenant quota → declared
size → hard byte-count during transfer → magic-byte sniffing → declared-vs-sniffed MIME
agreement → extension allowlist → per-format structural sanity → malware scan →
decompression-bomb guards → admitted.

- Client-declared content type is **never** trusted (`context.md` §3.2.5).
- A failing file is moved to a quarantine prefix and its `BookFile.status` becomes
  `REJECTED` with a reason code. Rejection is **terminal**: it is not retryable without a
  new upload (`context.md` §3.2.5).
- Uploaded filenames are stored as metadata and **never** used to construct an object key
  (`context.md` §18.5).

### 14.6 CSRF

Cookie-authenticated unsafe requests require the `X-CSRF-Token` header matching a
non-`HttpOnly` companion cookie (double-submit). `SameSite=Lax` is the second layer, not the
only one. Bearer-token requests are not CSRF-exposed and do not require the header. A
missing or mismatched token is `403 CSRF_TOKEN_INVALID`.

### 14.7 SSRF

- **No endpoint accepts a URL from a client and fetches it.** Cover art, reference audio, and
  book files are supplied by uploading to a server-issued presigned target — never by giving
  the server a URL to retrieve.
- Webhook delivery targets are not part of v1 (§16.19); when introduced they will require an
  egress allowlist and a §27 change.
- Object-storage endpoints are server configuration, never derived from a request.

### 14.8 Path traversal and key construction

Object keys are constructed by the server from validated identifiers only, following the key
contract in `context.md` §12.3. No user-supplied string — filename, title, character name,
cursor, or header — ever becomes part of a key path. Every key is validated against its
expected pattern before use. The API **never** accepts an object key as an input parameter
and **never** returns a raw key to a public client; binaries are reached only through
`.../access-urls` (§16.20).

### 14.9 Object-storage security

- Buckets are private. There is no public object URL, ever (`context.md` §12.3, §18.7).
- All byte access is via short-lived signed URLs, scoped to a **single object** and a
  **single method**, minted only after an ownership check, with expiry in minutes
  (`configuration`).
- Signed URLs are never logged, never included in error bodies, and never embedded in an
  event payload (`context.md` rule 20).
- Server-side encryption at rest; TLS in transit.

### 14.10 Prompt injection

`context.md` §18.9 governs the LLM boundary; the API-visible consequences are:

- The API exposes **no endpoint that forwards client-supplied instructions to a model.**
  There is no `prompt` field, no `system_prompt` field, and no free-form "instructions"
  parameter anywhere in this specification. Director behavior is selected by
  `director_version`, which names a reviewed bundle — not by client text.
- Director dry-run (§17.4) is an internal endpoint with a bounded, rate-limited scope; it is
  not publicly exposed and it persists nothing.
- LLM output reaching the API has already passed the §12.5 validation chain, so no API
  response can carry an unvalidated model-authored identifier, offset, or enum value.
- Model output is never rendered as HTML by the API and never used to construct a URL, key,
  or query (`context.md` §18.9 rule 6).

### 14.11 Sensitive error handling

Per §8.2: no stack traces, no internal identifiers, no keys, no signed URLs, no book text in
errors. Authentication failures are uniform in shape and timing: a wrong password and an
unknown account return the same `401 UNAUTHENTICATED` with the same latency profile, so the
API is not a user-enumeration oracle. Password reset always returns `202` regardless of
whether the address exists.

### 14.12 Auditing

Every state-changing administrative action, every signed-URL mint, every voice approval and
lock, every forced regeneration, every purge, and every cross-tenant administrative read is
written to an audit record carrying principal, tenant, resource, action, `request_id`, and
`trace_id`. Audit records are append-only.

---

## 15. Endpoint catalog

The complete public surface, grouped by domain. `Auth` column: `-` none, `U` user token or
session, `A` `PLATFORM_ADMIN`, `S` service/worker credential. `Async` marks endpoints that
return `202` with a job handle. `Idem` marks endpoints requiring `Idempotency-Key`.

### 15.1 Authentication

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | - | | | §16.1 |
| POST | `/api/v1/auth/login` | - | | | §16.1 |
| POST | `/api/v1/auth/mfa` | - | | | §16.1 |
| POST | `/api/v1/auth/refresh` | - | | | §16.1 |
| POST | `/api/v1/auth/logout` | U | | | §16.1 |
| POST | `/api/v1/auth/password-reset` | - | | | §16.1 |
| POST | `/api/v1/auth/password-reset/confirm` | - | | | §16.1 |

### 15.2 Users

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/users/me` | U | | | §16.2 |
| PATCH | `/api/v1/users/me` | U | | | §16.2 |
| GET | `/api/v1/users/me/quotas` | U | | | §16.2 |
| GET | `/api/v1/users/me/sessions` | U | | | §16.2 |
| DELETE | `/api/v1/users/me/sessions/{sessionId}` | U | | | §16.2 |

### 15.3 Books

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books` | U | | yes | §16.3 |
| GET | `/api/v1/books` | U | | | §16.4 |
| GET | `/api/v1/books/{bookId}` | U | | | §16.5 |
| PATCH | `/api/v1/books/{bookId}` | U | | | §16.5 |
| DELETE | `/api/v1/books/{bookId}` | U | | | §16.6 |
| POST | `/api/v1/books/{bookId}/restoration` | U | | | §16.6 |
| POST | `/api/v1/books/{bookId}/purge` | U | yes | yes | §16.6 |

### 15.4 Uploads

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/upload-sessions` | U | | yes | §16.6 |
| GET | `/api/v1/books/{bookId}/upload-sessions/{sessionId}` | U | | | §16.6 |
| POST | `/api/v1/books/{bookId}/upload-sessions/{sessionId}/completion` | U | yes | yes | §16.6 |
| DELETE | `/api/v1/books/{bookId}/upload-sessions/{sessionId}` | U | | | §16.6 |
| GET | `/api/v1/books/{bookId}/files` | U | | | §16.6 |
| GET | `/api/v1/books/{bookId}/files/{bookFileId}` | U | | | §16.6 |
| POST | `/api/v1/books/{bookId}/files/{bookFileId}/access-urls` | U | | | §16.20 |

### 15.5 Ingestion

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/ingestion` | U | yes | yes | §16.7 |
| GET | `/api/v1/books/{bookId}/ingestion` | U | | | §16.7 |

### 15.6 Structure — chapters, sections, scenes, paragraphs, text

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/books/{bookId}/chapters` | U | | | §16.8 |
| GET | `/api/v1/books/{bookId}/chapters/{chapterId}` | U | | | §16.8 |
| PATCH | `/api/v1/books/{bookId}/chapters/{chapterId}` | U | | | §16.8 |
| GET | `/api/v1/books/{bookId}/sections` | U | | | §16.8 |
| GET | `/api/v1/books/{bookId}/scenes` | U | | | §16.9 |
| GET | `/api/v1/books/{bookId}/scenes/{sceneId}` | U | | | §16.9 |
| GET | `/api/v1/books/{bookId}/paragraphs` | U | | | §16.8 |
| POST | `/api/v1/books/{bookId}/text/access-urls` | U | | | §16.20 |

### 15.7 Analysis and Story Bible

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/analysis` | U | yes | yes | §16.10 |
| GET | `/api/v1/books/{bookId}/analysis` | U | | | §16.10 |
| GET | `/api/v1/books/{bookId}/story-bible` | U | | | §16.12 |
| GET | `/api/v1/books/{bookId}/story-bible/snapshots` | U | | | §16.12 |
| GET | `/api/v1/books/{bookId}/story-bible/snapshots/{snapshotId}` | U | | | §16.12 |
| GET | `/api/v1/books/{bookId}/story-bible/pronunciations` | U | | | §16.12 |
| POST | `/api/v1/books/{bookId}/story-bible/pronunciations` | U | | | §16.12 |
| PATCH | `/api/v1/books/{bookId}/story-bible/pronunciations/{entryId}` | U | | | §16.12 |
| DELETE | `/api/v1/books/{bookId}/story-bible/pronunciations/{entryId}` | U | | | §16.12 |

### 15.8 Characters

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/books/{bookId}/characters` | U | | | §16.11 |
| GET | `/api/v1/books/{bookId}/characters/{characterId}` | U | | | §16.11 |
| PATCH | `/api/v1/books/{bookId}/characters/{characterId}` | U | | | §16.11 |
| GET | `/api/v1/books/{bookId}/characters/{characterId}/aliases` | U | | | §16.11 |
| POST | `/api/v1/books/{bookId}/characters/{characterId}/aliases` | U | | | §16.11 |
| PATCH | `/api/v1/books/{bookId}/characters/{characterId}/aliases/{aliasId}` | U | | | §16.11 |
| DELETE | `/api/v1/books/{bookId}/characters/{characterId}/aliases/{aliasId}` | U | | | §16.11 |
| POST | `/api/v1/books/{bookId}/character-merges` | U | yes | yes | §16.11 |
| GET | `/api/v1/books/{bookId}/character-merges` | U | | | §16.11 |
| GET | `/api/v1/books/{bookId}/characters/{characterId}/voice` | U | | | §16.14 |
| PUT | `/api/v1/books/{bookId}/characters/{characterId}/voice` | U | | | §16.14 |
| DELETE | `/api/v1/books/{bookId}/characters/{characterId}/voice` | U | | | §16.14 |

### 15.9 Director and Audio Script

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/director` | U | yes | yes | §16.13 |
| GET | `/api/v1/books/{bookId}/director` | U | | | §16.13 |
| GET | `/api/v1/books/{bookId}/audio-script` | U | | | §16.13 |
| GET | `/api/v1/books/{bookId}/audio-scripts` | U | | | §16.13 |
| GET | `/api/v1/books/{bookId}/audio-scripts/{audioScriptId}` | U | | | §16.13 |
| GET | `/api/v1/books/{bookId}/audio-script-chunks` | U | | | §16.13 |
| GET | `/api/v1/books/{bookId}/audio-script-chunks/{chunkId}` | U | | | §16.13 |
| PATCH | `/api/v1/books/{bookId}/audio-script-chunks/{chunkId}` | U | | | §16.13 |

### 15.10 Voice profiles, versions, previews, casting

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/voice-profiles` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles` | U | | opt | §16.14 |
| GET | `/api/v1/voice-profiles/{voiceProfileId}` | U | | | §16.14 |
| PATCH | `/api/v1/voice-profiles/{voiceProfileId}` | U | | | §16.14 |
| DELETE | `/api/v1/voice-profiles/{voiceProfileId}` | U | | | §16.14 |
| GET | `/api/v1/voice-profiles/{voiceProfileId}/versions` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions` | U | | yes | §16.14 |
| GET | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/reference-audio` | U | | yes | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/reference-audio/completion` | U | | yes | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/previews` | U | yes | yes | §16.14 |
| GET | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/previews` | U | | | §16.14 |
| GET | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/previews/{previewId}` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/approval` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/lock` | U | | | §16.14 |
| POST | `/api/v1/voice-profiles/{voiceProfileId}/versions/{version}/retirement` | U | | | §16.14 |
| GET | `/api/v1/books/{bookId}/voice-profiles` | U | | | §16.14 |
| GET | `/api/v1/books/{bookId}/casting` | U | | | §16.14 |
| POST | `/api/v1/books/{bookId}/casting/narrator-fallback` | U | | | §16.14 |

### 15.11 TTS and audio chunks

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/tts` | U | yes | yes | §16.15 |
| GET | `/api/v1/books/{bookId}/tts` | U | | | §16.15 |
| GET | `/api/v1/books/{bookId}/audio-chunks` | U | | | §16.15 |
| GET | `/api/v1/books/{bookId}/audio-chunks/{audioChunkId}` | U | | | §16.15 |
| POST | `/api/v1/books/{bookId}/audio-chunks/{audioChunkId}/access-urls` | U | | | §16.20 |

### 15.12 Assembly and audiobook

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/assembly` | U | yes | yes | §16.16 |
| GET | `/api/v1/books/{bookId}/assembly` | U | | | §16.16 |
| GET | `/api/v1/books/{bookId}/chapter-audio` | U | | | §16.16 |
| GET | `/api/v1/books/{bookId}/chapter-audio/{chapterAudioId}` | U | | | §16.16 |
| GET | `/api/v1/books/{bookId}/audiobook` | U | | | §16.17 |
| GET | `/api/v1/books/{bookId}/audiobooks` | U | | | §16.17 |
| GET | `/api/v1/books/{bookId}/audiobooks/{audiobookId}` | U | | | §16.17 |
| PATCH | `/api/v1/books/{bookId}/audiobooks/{audiobookId}` | U | | | §16.17 |
| PUT | `/api/v1/books/{bookId}/audiobooks/{audiobookId}/cover` | U | | | §16.17 |

### 15.13 Streaming and downloads

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/books/{bookId}/audiobooks/{audiobookId}/access-urls` | U | | | §16.20 |
| POST | `/api/v1/books/{bookId}/chapter-audio/{chapterAudioId}/access-urls` | U | | | §16.20 |
| POST | `/api/v1/voice-profiles/{id}/versions/{version}/previews/{previewId}/access-urls` | U | | | §16.20 |

### 15.14 Jobs and progress

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/jobs` | U | | | §16.18 |
| GET | `/api/v1/jobs/{jobId}` | U | | | §16.18 |
| GET | `/api/v1/jobs/{jobId}/attempts` | U | | | §16.18 |
| POST | `/api/v1/jobs/{jobId}/cancellation` | U | | | §16.18 |
| GET | `/api/v1/jobs/{jobId}/events` | U | | | §16.19 |
| GET | `/api/v1/books/{bookId}/progress` | U | | | §16.19 |
| GET | `/api/v1/books/{bookId}/events` | U | | | §16.19 |

### 15.15 Platform metadata

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/capabilities` | U | | | §16.21 |
| GET | `/api/v1/model-versions` | U | | | §16.21 |
| GET | `/api/v1/model-versions/{modelVersionId}` | U | | | §16.21 |

### 15.16 Administration

| Method | Path | Auth | Async | Idem | Spec |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/admin/tenants` | A | | | §16.22 |
| GET | `/api/v1/admin/tenants/{tenantId}` | A | | | §16.22 |
| PATCH | `/api/v1/admin/tenants/{tenantId}/quotas` | A | | | §16.22 |
| GET | `/api/v1/admin/users` | A | | | §16.22 |
| GET | `/api/v1/admin/jobs` | A | | | §16.22 |
| POST | `/api/v1/admin/jobs/{jobId}/replay` | A | yes | yes | §16.22 |
| POST | `/api/v1/admin/jobs/{jobId}/cancellation` | A | | | §16.22 |
| GET | `/api/v1/admin/dead-letters` | A | | | §16.22 |
| GET | `/api/v1/admin/model-versions` | A | | | §16.22 |
| GET | `/api/v1/admin/workers` | A | | | §16.22 |

### 15.17 Health (not publicly routed)

| Method | Path | Auth | Spec |
| --- | --- | --- | --- |
| GET | `/health` | - | §19 |
| GET | `/ready` | - | §19 |
| GET | `/health/dependencies` | S | §19 |
| GET | `/metrics` | S | §19 |

### 15.18 Domains deliberately absent from v1

| Domain | Status | Reason |
| --- | --- | --- |
| Notifications / webhooks | **Not specified** | `context.md` §3.2.15 defines the service, but no public contract for preferences or webhook registration is required by any v1 workflow. Introducing one needs §27. SSE (§16.19) covers in-session progress. |
| Review items | **Reserved, not specified** | `context.md` §14.5 mandates a review surface, but no `ReviewItem` entity exists in §4.2. See OQ-3 (§24). Review information is currently surfaced as `review_flags` on chunks and `needs_review` counters on progress. |
| Search across books | **Not offered** | `context.md` §3.3 defers it. |
| Billing | **Not offered** | `context.md` §3.3 defers it. |
| Programmatic API keys | **Not offered** | OQ-7 (§24). |
| Collaboration / sharing | **Not offered** | OQ-4 (§24). |
---

## 16. Public API — endpoint specifications

Every endpoint below follows the same structure: **Purpose / Authentication /
Authorization / Path parameters / Query parameters / Request body / Response / Status codes
/ Errors / Idempotency / Side effects / Async behavior / Related job**. A field marked "—"
does not apply to that endpoint.

Rules that apply to **every** endpoint and are not repeated:

- The response envelope is §7; the error envelope is §8.
- `401` is possible on every authenticated endpoint; `429`, `500`, and `503` are possible on
  every endpoint. They are listed per endpoint only where the behavior is unusual.
- Ownership is enforced in the owning service (§6.1); cross-tenant references yield `404`
  (§6.4).
- Unknown request fields and unknown query parameters are rejected (§12.2, §10.4).

---

### 16.1 Authentication

#### Register

`POST /api/v1/auth/register`

- **Purpose:** Create a principal and its tenant. In v1 each registration creates one tenant
  with the new user as `TENANT_OWNER` (`context.md` §19.1 single implicit project).
- **Authentication:** None.
- **Authorization:** None. Rate-limited under the `auth` bucket (§14.3).
- **Request body:** `{ "email": string, "password": string, "display_name": string|null }`.
  Password strength rules are `configuration`; failures are `422` with
  `details[].issue = "too_short"` or `"invalid_format"`.
- **Response:** `201` with `{ "data": { "user": {...}, "tenant_id": "..." } }`. No tokens are
  issued: registration and login are separate so that email verification can be inserted
  without a contract change.
- **Status codes:** `201`, `400`, `409`, `422`, `429`.
- **Errors:** `EMAIL_ALREADY_REGISTERED` (`409`) — returned only when registration is
  configured as non-enumerating-exempt; when enumeration protection is on (`configuration`,
  default **on**) the response is `201` with a neutral body and a verification email decides
  the outcome. `VALIDATION_FAILED` (`422`).
- **Idempotency:** Not required; the unique-email constraint makes it naturally idempotent.
- **Side effects:** Creates `User` and tenant; emits `user.registered` (`context.md` §3.2.2).
- **Async behavior / Related job:** None. The `user.registered` event drives notification
  delivery asynchronously.

#### Login

`POST /api/v1/auth/login`

- **Purpose:** Exchange credentials for tokens or a session.
- **Authentication:** None.
- **Authorization:** None. `auth` rate bucket; progressive delay and lockout on repeated
  failure.
- **Request body:** `{ "email": string, "password": string, "client_type": "BROWSER"|"API" }`.
- **Response:** `200`.
  - `client_type: "API"` →
    `{ "data": { "status": "AUTHENTICATED", "access_token": "...", "expires_in": 900, "refresh_token": "...", "token_type": "Bearer" } }`
  - `client_type: "BROWSER"` → `{ "data": { "status": "AUTHENTICATED" } }` plus the `session`
    cookie and a CSRF companion cookie. No tokens in the body.
  - MFA-enabled principal → `{ "data": { "status": "MFA_REQUIRED", "mfa_token": "..." } }`
    (§5.5).
- **Status codes:** `200`, `400`, `401`, `422`, `429`.
- **Errors:** `UNAUTHENTICATED` (`401`) — identical shape and timing for an unknown account
  and a wrong password (§14.11). `ACCOUNT_LOCKED` (`429`) with `Retry-After`.
- **Idempotency / Async / Related job:** Not applicable.
- **Side effects:** Creates a session and a refresh-token family; audit record written.

#### Complete MFA

`POST /api/v1/auth/mfa`

- **Purpose:** Exchange an `mfa_token` plus a factor response for tokens or a session.
- **Authentication:** None (the `mfa_token` is the credential; it is single-use and
  short-lived).
- **Request body:** `{ "mfa_token": string, "code": string }`.
- **Response / Status codes:** As **Login**. `401 MFA_FAILED` on an invalid code.
- **Note:** Factor enrolment endpoints are **reserved** (§5.5, OQ-6). Implementations
  **MUST NOT** invent them.

#### Refresh

`POST /api/v1/auth/refresh`

- **Purpose:** Rotate a refresh token into a new access token.
- **Authentication:** The refresh token itself — in the body for API clients, in the session
  cookie for browsers.
- **Request body:** `{ "refresh_token": string }` for API clients; empty for browsers.
- **Response:** `200` with a new `access_token` and a **new** `refresh_token` (rotation,
  §5.3).
- **Status codes:** `200`, `401`, `429`.
- **Errors:** `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `REFRESH_TOKEN_REUSED` (`401`; revokes the
  whole family and writes a security audit record).
- **Side effects:** Rotates the token family.

#### Logout

`POST /api/v1/auth/logout`

- **Purpose:** Revoke the current session and its refresh-token family.
- **Authentication:** Required (`U`).
- **Authorization:** The principal's own session only.
- **Response:** `204`, and the session cookie is cleared for browser clients.
- **Idempotency:** Naturally idempotent — logging out twice is `204` both times.
- **Side effects:** Server-side session revocation (§5.4). Clearing the cookie alone is never
  sufficient.

#### Request password reset / Confirm password reset

`POST /api/v1/auth/password-reset` · `POST /api/v1/auth/password-reset/confirm`

- **Purpose:** Initiate and complete a password reset.
- **Authentication:** None. `auth` rate bucket.
- **Request bodies:** `{ "email": string }` and
  `{ "reset_token": string, "new_password": string }`.
- **Response:** Request → `202` **always**, regardless of whether the address exists
  (§14.11). Confirm → `204`, and every session and refresh token for the principal is
  revoked.
- **Status codes:** `202` / `204`, `401` (invalid or expired reset token), `422`, `429`.
- **Async behavior:** Email delivery is asynchronous via the Notification Service; the `202`
  refers to accepting the request, not to sending the mail. No public job handle is exposed
  for notification delivery.

---

### 16.2 Users

#### Get current user

`GET /api/v1/users/me`

- **Purpose:** The authenticated principal's profile, tenant, roles, and preferences.
- **Authentication:** Required. **Authorization:** Self only. There is no
  `GET /users/{userId}` in v1 — a user can read only themselves, and administrators use
  `/admin/users` (§16.22).
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9Z0USR00000000000000001",
    "object": "user",
    "email": "reader@example.com",
    "display_name": "Reader",
    "tenant_id": "01J9Z0TEN00000000000000001",
    "roles": ["TENANT_OWNER"],
    "preferences": { "locale": "en-GB", "notification_email": true },
    "created_at": "2026-01-04T09:00:00.000Z",
    "updated_at": "2026-08-01T12:00:00.000Z",
    "links": { "self": "/api/v1/users/me", "quotas": "/api/v1/users/me/quotas" }
  }
}
```

- **Status codes:** `200`, `401`. **Errors:** none specific.
- **Side effects:** None. `ETag` returned.

#### Update current user

`PATCH /api/v1/users/me`

- **Purpose:** Update profile fields and preferences.
- **Authorization:** Self only. `email` and `roles` are **not** patchable here: an email
  change is an auth-domain operation (reserved, OQ-6) and roles are administrative.
- **Request body:** any subset of `{ "display_name", "preferences" }`.
- **Response:** `200` with the updated resource. **Status codes:** `200`, `401`, `409`
  (`If-Match` mismatch), `422`.
- **Idempotency:** `PATCH` is idempotent by method.

#### Get quotas and usage

`GET /api/v1/users/me/quotas`

- **Purpose:** Current tenant quotas and usage counters (`context.md` §3.2.3), so the client
  can show remaining capacity before starting expensive work.
- **Authorization:** Own tenant only.
- **Response:** `200`

```json
{
  "data": {
    "object": "quota_summary",
    "tenant_id": "01J9Z0TEN00000000000000001",
    "degraded": false,
    "quotas": {
      "concurrent_books": { "limit": 3, "used": 1 },
      "gpu_minutes_monthly": { "limit": 1200, "used": 340 },
      "storage_bytes": { "limit": 214748364800, "used": 51539607552 },
      "books_total": { "limit": 50, "used": 7 }
    },
    "period_start": "2026-08-01T00:00:00.000Z",
    "period_end": "2026-09-01T00:00:00.000Z"
  }
}
```

- **Degradation:** If the usage aggregator is unavailable, the response is `200` with
  `degraded: true` and `used` values `null` (`context.md` §3.2.3 — quota reads fail open).
  Quota *enforcement* on expensive work fails **closed** and is enforced at job creation, not
  here.
- **Status codes:** `200`, `401`.

#### List and revoke sessions

`GET /api/v1/users/me/sessions` · `DELETE /api/v1/users/me/sessions/{sessionId}`

- **Purpose:** Let a user see and revoke their active sessions and refresh-token families
  (§5.4).
- **Authorization:** Self only; a session belonging to another principal is `404`.
- **Response:** `200` collection (`object: "session"`, fields: `id`, `created_at`,
  `last_seen_at`, `user_agent_family`, `ip_country`, `current`); `DELETE` → `204`.
- **Side effects:** Revocation is immediate and propagates to the token revocation list.

---

### 16.3 Create book

`POST /api/v1/books`

- **Purpose:** Create the `Book` aggregate root. This is the first step of every workflow;
  a book exists before any file is uploaded (`context.md` §4.4: `CREATED → UPLOADED → ...`).
- **Authentication:** Required.
- **Authorization:** Any `TENANT_MEMBER` or `TENANT_OWNER`. The book is created in the
  principal's tenant; `tenant_id` is **never** accepted from the client.
- **Request headers:** `Idempotency-Key` **required** (§11.1).
- **Path parameters:** —
- **Query parameters:** —
- **Request body:**

```json
{
  "title": "The Lighthouse at the End of the World",
  "author": "Jules Verne",
  "language": "en-GB",
  "description": null,
  "metadata": {
    "series": null,
    "series_index": null,
    "publication_year": 1905,
    "publisher": null
  }
}
```

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `title` | string | Yes | 1–512 chars |
| `author` | string | No | 0–512 chars |
| `language` | string | Yes | BCP-47 |
| `description` | string\|null | No | 0–8192 chars |
| `metadata` | object\|null | No | Fixed keys only; unknown keys rejected |

- **Response:** `201`, `Location: /api/v1/books/{bookId}`

```json
{
  "data": {
    "id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "object": "book",
    "tenant_id": "01J9Z0TEN00000000000000001",
    "title": "The Lighthouse at the End of the World",
    "author": "Jules Verne",
    "language": "en-GB",
    "description": null,
    "status": "CREATED",
    "pipeline_version": "pipeline.v1",
    "structure_version": null,
    "counts": { "chapters": 0, "scenes": 0, "characters": 0, "audio_script_chunks": 0, "audio_chunks": 0 },
    "needs_review_count": 0,
    "metadata": { "series": null, "series_index": null, "publication_year": 1905, "publisher": null },
    "created_at": "2026-08-27T11:04:03.221Z",
    "updated_at": "2026-08-27T11:04:03.221Z",
    "deleted_at": null,
    "links": { "self": "/api/v1/books/01J9Z2K7Q0V6Y8B3M4N5P6R7S8" }
  }
}
```

- **Status codes:** `201`, `400`, `401`, `409`, `422`, `429`.
- **Errors:** `MISSING_IDEMPOTENCY_KEY` (`400`), `IDEMPOTENCY_KEY_CONFLICT` (`409`),
  `VALIDATION_FAILED` (`422`), `QUOTA_EXCEEDED` (`429`) when `books_total` or
  `concurrent_books` is exhausted.
- **Idempotency:** Required. Replay returns the original `201` and the same `book_id`.
- **Side effects:** Creates `Book` in state `CREATED`. Emits no pipeline event yet
  (`book.uploaded` comes from ingestion, `context.md` §11.3).
- **Async behavior / Related job:** None. Book creation is metadata-only and therefore
  permitted to be synchronous (`context.md` §2.3).

---

### 16.4 List books

`GET /api/v1/books`

- **Purpose:** The tenant's library.
- **Authentication:** Required. **Authorization:** Scoped to the caller's tenant by
  construction; there is no parameter that can widen the scope.
- **Query parameters:**

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `status` | enum, multi | — | Book lifecycle state (§20.1) |
| `language` | string | — | BCP-47 exact match |
| `created_after`, `created_before` | RFC 3339 | — | Inclusive |
| `include_deleted` | boolean | `false` | `TENANT_OWNER` only; otherwise `403 INSUFFICIENT_SCOPE` |
| `sort` | string | `created_at:desc` | Allowlist: `created_at`, `updated_at`, `title` |
| `limit`, `cursor`, `before`, `include_total` | — | — | §10 |

- **Response:** `200` collection of book resources (§16.3 shape).
- **Status codes:** `200`, `401`, `403`, `422`.
- **Errors:** `INVALID_CURSOR`, `INVALID_SORT_FIELD`, `VALIDATION_FAILED` (`422`).
- **Side effects:** None. Read-heavy; may be served from a Redis-cached read model
  (`context.md` §3.2.4).

---

### 16.5 Get and update a book

#### Get book

`GET /api/v1/books/{bookId}`

- **Purpose:** Full book metadata plus derived counts and stage summary.
- **Authorization:** `book.tenant_id == principal.tenant_id`, enforced in the Book Service.
- **Path parameters:** `bookId` — ULID/UUIDv7.
- **Query parameters:** `include=stages` (optional) adds a compact per-stage summary
  identical to the `GET .../{stage}` responses, so a UI can render a pipeline overview in one
  request. No other `include` values are permitted.
- **Response:** `200`, book resource (§16.3) plus, with `include=stages`:

```json
{
  "data": {
    "id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "object": "book",
    "status": "GENERATING",
    "stages": {
      "ingestion": { "status": "SUCCEEDED", "completed_at": "2026-08-27T11:20:00.000Z" },
      "analysis":  { "status": "SUCCEEDED", "completed_at": "2026-08-27T12:40:00.000Z" },
      "director":  { "status": "SUCCEEDED", "completed_at": "2026-08-27T14:05:00.000Z", "director_version": "director.v3" },
      "tts":       { "status": "RUNNING", "progress": 0.42 },
      "assembly":  { "status": null }
    }
  }
}
```

- **Status codes:** `200`, `304`, `401`, `404`, `410`, `422`.
- **Errors:** `BOOK_NOT_FOUND` (`404`), `RESOURCE_PURGED` (`410`).
- **Side effects:** None. Returns `ETag`.

#### Update book metadata

`PATCH /api/v1/books/{bookId}`

- **Purpose:** Change user-editable metadata. **Not** a way to change pipeline state: `status`
  is not patchable, and any attempt is `422` / `immutable`.
- **Authorization:** Own tenant.
- **Request headers:** `If-Match` optional (§2.8).
- **Request body:** any subset of `{ "title", "author", "language", "description",
  "metadata" }`.
- **Response:** `200` with the updated book.
- **Status codes:** `200`, `401`, `404`, `409`, `422`.
- **Errors:** `RESOURCE_VERSION_CONFLICT` (`409`), `VALIDATION_FAILED` (`422`),
  `INVALID_STATE_TRANSITION` (`409`) when `language` is changed after ingestion has produced
  canonical text — language participates in parsing and Director decisions, so changing it
  post-ingestion is refused with a message directing the user to create a new book.
- **Side effects:** Metadata only. Changing `title`/`author` does **not** rewrite existing
  `Audiobook` artifacts: embedded metadata is fixed at assembly time (`context.md` §13.4), and
  the change applies to the **next** assembly.
- **Async behavior / Related job:** None.

---

### 16.6 Book deletion and the upload workflow

#### 16.6.1 Delete (soft) a book

`DELETE /api/v1/books/{bookId}`

- **Purpose:** Remove the book from the user's library.
- **Decision — soft delete.** `context.md` §4.1 mandates soft deletion for user-facing
  entities (`deleted_at`), and §4.4 defines **no `ARCHIVED` state**. Deletion is therefore a
  `deleted_at` stamp, not a lifecycle state, and "archive" is not a separate concept in this
  API. Recorded as conflict C-3 in §23 against the commissioning brief's "delete/archive"
  phrasing.
- **Authorization:** Own tenant.
- **Response:** `204`.
- **Status codes:** `204`, `401`, `404`, `409`.
- **Errors:** `BOOK_HAS_ACTIVE_JOBS` (`409`) when jobs for this book are `QUEUED`,
  `RUNNING`, or `RETRYING`. The message directs the caller to cancel them first
  (§16.18). Deleting a book out from under running GPU work would orphan spend.
- **Idempotency:** Naturally idempotent; deleting an already-deleted book is `204`.
- **Side effects:** Sets `deleted_at`. The book disappears from `GET /books` unless
  `include_deleted=true`. **Artifacts are retained** for the retention window
  (`context.md` §12.3): audio chunks are not deleted while the audiobook is
  regenerable-on-demand.
- **Async behavior:** None. Retention-driven cleanup runs later as a `cleanup_artifacts` job
  (`context.md` §11.2) that is not attributable to this request and is not exposed publicly.

#### 16.6.2 Restore a book

`POST /api/v1/books/{bookId}/restoration`

- **Purpose:** Undo a soft delete within the retention window.
- **Authorization:** `TENANT_OWNER`.
- **Request body:** empty.
- **Response:** `200` with the restored book.
- **Status codes:** `200`, `401`, `403`, `404`, `409`, `410`.
- **Errors:** `RESOURCE_PURGED` (`410`) if the book was hard-purged;
  `INVALID_STATE_TRANSITION` (`409`) if the book is not deleted.
- **Side effects:** Clears `deleted_at`. Restores the book to the lifecycle state it held at
  deletion — restoration never advances or rewinds the pipeline.

#### 16.6.3 Purge a book

`POST /api/v1/books/{bookId}/purge`

- **Purpose:** Irreversible, complete deletion of metadata, artifacts, caches, and queue
  entries (`context.md` §19.2 — "deletion is tenant-scoped and complete").
- **Authorization:** `TENANT_OWNER` only.
- **Request headers:** `Idempotency-Key` **required**.
- **Request body:** `{ "confirm_book_id": "<bookId>" }` — must equal the path parameter, or
  `422` / `inconsistent_with`. A destructive irreversible operation requires an explicit
  confirmation token in the body.
- **Preconditions:** The book **MUST** already be soft-deleted, and **MUST** have no active
  jobs. Otherwise `409`.
- **Response:** `202` with a job handle (§7.3).
- **Status codes:** `202`, `400`, `401`, `403`, `404`, `409`, `422`.
- **Errors:** `INVALID_STATE_TRANSITION` (`409`) when not soft-deleted;
  `BOOK_HAS_ACTIVE_JOBS` (`409`).
- **Async behavior:** Purge is asynchronous because it deletes potentially millions of
  objects. After the job succeeds, every endpoint for this `bookId` returns `410
  RESOURCE_PURGED`.
- **Related job:** `cleanup_artifacts` (`context.md` §11.2, `maintenance` queue).
- **Side effects:** Irreversible. Audited (§14.12).

#### 16.6.4 Upload workflow overview

The upload flow is **two-phase and byte-free at the API** (`context.md` §25.8, §3.2.5). Bytes
travel client → object storage directly; the API never proxies them.

```
POST /books                                          -> book exists
POST /books/{bookId}/upload-sessions                 -> presigned target(s) + session id
PUT  <presigned url(s)>          (client -> object storage, not this API)
POST /books/{bookId}/upload-sessions/{id}/completion  -> validate, create BookFile, 202 + job
GET  /books/{bookId}/upload-sessions/{id}             -> observe validation state
POST /books/{bookId}/ingestion                        -> start parsing, 202 + job
```

The **finalization** step is what admits the file; it is where the §14.5 validation chain
runs, and it is where the `book.uploaded` event originates.

#### 16.6.5 Create an upload session

`POST /api/v1/books/{bookId}/upload-sessions`

- **Purpose:** Obtain a server-issued presigned upload target and register the client's
  declared file facts for later verification.
- **Authorization:** Own tenant; the book must not be soft-deleted.
- **Request headers:** `Idempotency-Key` **required**.
- **Request body:**

```json
{
  "file_name": "lighthouse.pdf",
  "declared_mime_type": "application/pdf",
  "declared_size_bytes": 48213004,
  "declared_content_hash": { "algorithm": "sha256", "value": "9f2c...e1" },
  "source_kind": "PDF",
  "multipart": true,
  "part_count": 10
}
```

| Field | Required | Validation |
| --- | --- | --- |
| `file_name` | Yes | 1–255 chars. **Stored as metadata only**; never used to build an object key (`context.md` §18.5) |
| `declared_mime_type` | Yes | Allowlist. Declared type is never trusted; it is checked against sniffed bytes at finalization |
| `declared_size_bytes` | Yes | `> 0` and `<=` the per-format maximum, else `413 FILE_TOO_LARGE` |
| `declared_content_hash` | Yes | Verified after transfer; mismatch rejects the upload |
| `source_kind` | Yes | `PDF` \| `EPUB` \| `IMAGE_SET` (`context.md` §1.1, §3.2.6) |
| `multipart` | No | Required `true` above the multipart threshold (`configuration`) |
| `part_count` | Conditional | Required when `multipart: true`; bounded |

- **Response:** `201`, `Location: .../upload-sessions/{sessionId}`

```json
{
  "data": {
    "id": "01J9Z5UPS0000000000000001",
    "object": "upload_session",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "status": "AWAITING_UPLOAD",
    "multipart": true,
    "upload_targets": [
      { "part_number": 1, "method": "PUT", "url": "https://storage.example.com/...", "headers": { "Content-Type": "application/pdf" }, "expires_at": "2026-08-27T11:19:03.221Z" }
    ],
    "max_size_bytes": 524288000,
    "expires_at": "2026-08-27T12:04:03.221Z",
    "created_at": "2026-08-27T11:04:03.221Z",
    "links": { "self": "...", "completion": ".../completion" }
  }
}
```

- **Status codes:** `201`, `400`, `401`, `404`, `409`, `413`, `422`, `429`.
- **Errors:** `UNSUPPORTED_FILE_FORMAT` (`422`), `FILE_TOO_LARGE` (`413`),
  `QUOTA_EXCEEDED` (`429`, storage quota), `BOOK_NOT_FOUND` (`404`).
- **Idempotency:** Required. Replay returns the **same** session and the same targets; it
  does not mint new presigned URLs. (This is the one place presigned URLs are replayed —
  because the session, not the URL, is the resource, and it expires as a unit.)
- **Side effects:** Creates an upload session in Redis with a TTL (`context.md` §3.2.5);
  reserves quota. Expired sessions are garbage-collected and their partial objects removed.
- **Async behavior / Related job:** None yet.

#### 16.6.6 Get upload session state

`GET /api/v1/books/{bookId}/upload-sessions/{sessionId}`

- **Purpose:** Observe upload and validation state, including the reason for a rejection.
- **Authorization:** Own tenant.
- **Response:** `200` with the session; `status` from §20.6:
  `AWAITING_UPLOAD | UPLOADING | VALIDATING | ADMITTED | REJECTED | EXPIRED`, plus
  `validation`:

```json
{
  "data": {
    "id": "01J9Z5UPS0000000000000001",
    "object": "upload_session",
    "status": "REJECTED",
    "validation": {
      "declared_vs_sniffed_mime": "MISMATCH",
      "sniffed_mime_type": "application/zip",
      "size_check": "PASS",
      "checksum_check": "NOT_RUN",
      "structural_check": "NOT_RUN",
      "malware_scan": "NOT_RUN",
      "decompression_guard": "NOT_RUN"
    },
    "rejection_reason_code": "MIME_TYPE_MISMATCH",
    "book_file_id": null
  }
}
```

- **Status codes:** `200`, `401`, `404`.
- **Side effects:** None.

#### 16.6.7 Finalize an upload

`POST /api/v1/books/{bookId}/upload-sessions/{sessionId}/completion`

- **Purpose:** Close the upload, run the mandatory validation chain, create the `BookFile`,
  and emit `book.uploaded`.
- **Authorization:** Own tenant.
- **Request headers:** `Idempotency-Key` **required**.
- **Request body:**

```json
{
  "parts": [ { "part_number": 1, "etag": "\"5d41402abc4b2a76b9719d911017c592\"" } ],
  "observed_size_bytes": 48213004
}
```
  `parts` is required for multipart sessions and forbidden otherwise.
- **Response:** `202` with a job handle and the created file reference:

```json
{
  "data": {
    "job": { "id": "01J9Z6JOB0000000000000001", "object": "job", "type": "parse_book", "status": "CREATED", "book_id": "01J9Z2K...", "links": { "self": "/api/v1/jobs/01J9Z6JOB0000000000000001" } },
    "accepted": { "scope": "BOOK_FILE", "book_file_id": "01J9Z7BKF0000000000000001", "upload_session_status": "VALIDATING" }
  }
}
```

- **Status codes:** `202`, `400`, `401`, `404`, `409`, `413`, `422`, `429`.
- **Errors:**
  - `UPLOAD_INCOMPLETE` (`409`) — declared parts missing.
  - `CHECKSUM_MISMATCH` (`409`) — hash verification failed; the upload must be repeated.
  - `SIZE_LIMIT_EXCEEDED` (`413`) — actual bytes exceeded the declared or maximum size.
  - `MIME_TYPE_MISMATCH`, `UNSUPPORTED_FILE_FORMAT` (`422`).
  - `MALWARE_DETECTED`, `DECOMPRESSION_BOMB_DETECTED` (`422`) — object quarantined,
    `BookFile.status = REJECTED`. **Terminal and non-retryable without a new upload**
    (`context.md` §3.2.5).
  - `DUPLICATE_CONTENT_HASH` (`409`) — see below.
  - `UPLOAD_SESSION_EXPIRED` (`409`).
- **Duplicate detection:** Deduplication by content hash is performed **within the tenant
  only** and is forbidden across tenants (`context.md` §19.2 — cross-tenant dedupe would leak
  the existence of content). Behavior:
  - Same tenant, same hash, **same book** → idempotent: returns the existing `BookFile` and
    the existing job.
  - Same tenant, same hash, **different book** → `409 DUPLICATE_CONTENT_HASH` with
    `details[0].existing_book_id`, unless the request body carries `"allow_duplicate": true`,
    in which case a new `BookFile` is created that **references the same stored object** and
    the response is `202`. Bytes are stored once per tenant.
  - Different tenant → no comparison is performed at all, and no signal is emitted.
- **Idempotency:** Required. Replay returns the original `202` with the same `job_id`.
- **Side effects:** Creates `BookFile` (immutable, `context.md` §4.2 #3); moves the book to
  `UPLOADED`; emits `book.uploaded`; on failure moves the object to the quarantine prefix.
- **Async behavior:** Hashing of large objects and the malware scan run asynchronously
  (`context.md` §3.2.5). The `202` therefore covers validation **admission**, and the session
  status transitions `VALIDATING → ADMITTED | REJECTED`. A client **MUST** poll the session
  (or the job) rather than assuming admission.
- **Related job:** The returned job is the ingestion coordinator. Whether ingestion starts
  automatically on admission or waits for an explicit `POST .../ingestion` is a **book
  setting** (`auto_ingest`, default `true`); when `auto_ingest` is `false` the returned job
  is created in state `BLOCKED` until `POST .../ingestion` releases it.

#### 16.6.8 Abort an upload session

`DELETE /api/v1/books/{bookId}/upload-sessions/{sessionId}`

- **Purpose:** Abandon an upload and release the reserved quota and partial objects.
- **Response:** `204`. Idempotent. **Errors:** `409 INVALID_STATE_TRANSITION` if the session
  is already `ADMITTED`.

#### 16.6.9 List and read book files

`GET /api/v1/books/{bookId}/files` · `GET /api/v1/books/{bookId}/files/{bookFileId}`

- **Purpose:** The source artifacts of a book. `BookFile` is immutable
  (`context.md` §4.2 #3): a new upload is a new row, never an edit.
- **Authorization:** Own tenant.
- **Query parameters (list):** `status` (`ADMITTED`, `REJECTED`, `QUARANTINED`), `sort`
  (`created_at`), plus §10 pagination.
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9Z7BKF0000000000000001",
    "object": "book_file",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "source_kind": "PDF",
    "original_file_name": "lighthouse.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 48213004,
    "content_hash": { "algorithm": "sha256", "value": "9f2c...e1" },
    "status": "ADMITTED",
    "rejection_reason_code": null,
    "page_count": 412,
    "created_at": "2026-08-27T11:12:00.000Z",
    "links": { "self": "...", "access_urls": ".../access-urls" }
  }
}
```

  The object-storage key is **never** returned (§14.8). Byte access is via §16.20.
- **Status codes:** `200`, `401`, `404`. **Side effects:** None.
- **Mutation:** There is no `PATCH` or `DELETE` on a `BookFile`: `405`. Files are removed only
  by book purge or retention policy.
---

### 16.7 Ingestion

Ingestion is the Parser Service stage: parse/OCR → normalize → structural analysis
(`context.md` §3.2.6). It is one stage sub-resource because those three steps share a
runtime, a failure model, and a queue, and `context.md` §3.3 explicitly refuses to split
them into separate services.

#### Start ingestion

`POST /api/v1/books/{bookId}/ingestion`

- **Purpose:** Queue parsing of an admitted `BookFile`. **The HTTP request never parses
  anything** (`context.md` §2.3 hard rule).
- **Authentication:** Required. **Authorization:** Own tenant.
- **Request headers:** `Idempotency-Key` **required**.
- **Path parameters:** `bookId`.
- **Query parameters:** —
- **Request body:**

```json
{
  "book_file_id": "01J9Z7BKF0000000000000001",
  "scope": "BOOK",
  "options": {
    "ocr_language_hints": ["en"],
    "force_ocr": false,
    "parser_strategy": "AUTO"
  },
  "force": false,
  "priority": "NORMAL"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `book_file_id` | Yes | Must be `ADMITTED` and belong to this book |
| `scope` | Yes | `BOOK` \| `PAGES`. `PAGES` requires `page_numbers[]` and re-runs only those pages (`context.md` §21 row 3 — per-page resumability) |
| `options.ocr_language_hints` | No | BCP-47 tags |
| `options.force_ocr` | No | Forces the OCR path for a digital PDF |
| `options.parser_strategy` | No | `AUTO` \| `PRIMARY` \| `FALLBACK`. Names a **strategy**, never a library (`context.md` §23 row 13). An engine name here is a contract violation |
| `force` | No | §11.5 |
| `priority` | No | `INTERACTIVE` \| `NORMAL` \| `BULK` (`context.md` §11.4). `INTERACTIVE` is refused for book-scope work with `422` |

- **Preconditions:** book not deleted; `book_file_id` `ADMITTED`; no ingestion job currently
  `RUNNING` for this book unless `force: true`.
- **Response:** `202` (§7.3), `Location` = the job.
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** `BOOK_FILE_NOT_ADMITTED` (`409`), `INGESTION_ALREADY_RUNNING` (`409`),
  `QUOTA_EXCEEDED` (`429`), `MISSING_IDEMPOTENCY_KEY` (`400`).
- **Idempotency:** Required (§11.1). Job-level key: `parse:{book_file_id}:{parser_version}`
  (`context.md` §16.3).
- **Side effects:** Book state → `PARSING`. Emits `book.parse_started`.
- **Async behavior:** Always. The job is a DAG coordinator (`context.md` §16.4) that fans out
  to `ocr_page` per page for scanned input and then runs `normalize_text` and
  `analyze_structure`.
- **Related jobs:** `parse_book`, `ocr_page`, `normalize_text`, `analyze_structure`
  (`context.md` §11.2, `parse` queue).

#### Get ingestion state

`GET /api/v1/books/{bookId}/ingestion`

- **Purpose:** The current and historical ingestion state, including per-page OCR outcomes
  and text-QC findings (`context.md` §14.1).
- **Authorization:** Own tenant.
- **Query parameters:** `include=pages` adds the per-page confidence report (paginated
  separately by `page_cursor`); omitted by default because a 400-page book's report is large.
- **Response:** `200`

```json
{
  "data": {
    "object": "ingestion_state",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "status": "PARTIAL_OCR",
    "book_file_id": "01J9Z7BKF0000000000000001",
    "parser_strategy_used": "PRIMARY",
    "parser_model_version_id": "01J9ZMV0000000000000PARSE",
    "ocr_model_version_id": "01J9ZMV00000000000000OCR1",
    "pipeline_version": "pipeline.v1",
    "content_hash": "9f2c...e1",
    "structure_version": "structure.v1",
    "counts": { "pages_total": 412, "pages_ok": 409, "pages_needs_review": 3, "chapters": 40, "paragraphs": 8123 },
    "text_qc": {
      "outcome": "WARN",
      "checks": [
        { "check": "unbalanced_quotation_marks", "outcome": "WARN", "affected_chapter_ids": ["01J9Z4CH0000000000000012"] },
        { "check": "chapter_count_sanity", "outcome": "PASS" }
      ]
    },
    "degraded": false,
    "started_at": "2026-08-27T11:12:10.000Z",
    "completed_at": null,
    "current_job_id": "01J9Z6JOB0000000000000001",
    "history": [
      { "job_id": "01J9Z6JOB0000000000000001", "status": "RUNNING", "started_at": "2026-08-27T11:12:10.000Z", "scope": "BOOK" }
    ],
    "links": { "job": "/api/v1/jobs/01J9Z6JOB0000000000000001", "chapters": "/api/v1/books/01J9Z2K.../chapters" }
  }
}
```

- **Ingestion states (§20.5):** `NOT_STARTED | QUEUED | PARSING | OCR | NORMALIZING |
  ANALYZING_STRUCTURE | PARTIAL_OCR | NEEDS_REVIEW | COMPLETED | FAILED | CANCELLED`.
  These are stage states derived from job state and book state; they never replace the job
  vocabulary of §20.3 and never appear on a job resource.
- **Status codes:** `200`, `401`, `404`.
- **Side effects:** None.

---

### 16.8 Chapters, sections, and paragraphs

These are the reading spine (`context.md` §3.2.4, Appendix A "spine"). All reads; mutation is
narrowly gated.

#### List chapters

`GET /api/v1/books/{bookId}/chapters`

- **Purpose:** The chapter spine, in reading order.
- **Authorization:** Own tenant.
- **Query parameters:** `sort` (allowlist: `order_index`; default `order_index:asc`),
  `structure_version` (defaults to the book's current structure version — older versions are
  retained side-by-side and never merged, `context.md` §3.2.4), plus §10 pagination.
- **Response:** `200` collection of:

```json
{
  "id": "01J9Z4CH0000000000000012",
  "object": "chapter",
  "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
  "order_index": 12,
  "title": "The Keeper's Log",
  "structure_version": "structure.v1",
  "matter_type": "BODY",
  "counts": { "sections": 3, "scenes": 9, "paragraphs": 214, "audio_script_chunks": 268, "audio_chunks_generated": 268 },
  "text_qc_outcome": "PASS",
  "audio": { "chapter_audio_id": "01J9ZCA00000000000000012", "status": "ASSEMBLED", "duration_ms": 1842000 },
  "created_at": "...", "updated_at": "...",
  "links": { "self": "...", "paragraphs": "...?chapter_id=01J9Z4CH0000000000000012" }
}
```
  `matter_type` is `FRONT_MATTER | BODY | BACK_MATTER` (`context.md` §3.2.6 front/back matter
  detection).

- **Status codes:** `200`, `401`, `404`, `422`.

#### Get chapter

`GET /api/v1/books/{bookId}/chapters/{chapterId}`

- **Purpose:** One chapter with its counts and audio pointer. **Does not return chapter
  text** — canonical text lives in object storage (`context.md` §12.1) and is reached via
  §16.20.
- **Status codes:** `200`, `304`, `401`, `404`.

#### Update chapter

`PATCH /api/v1/books/{bookId}/chapters/{chapterId}`

- **Purpose:** Correct a structural-analysis result: chapter `title`, `matter_type`, or
  `order_index`.
- **Authorization:** Own tenant.
- **State gate (binding).** Mutation is permitted **only** while the chapter's paragraphs are
  not yet scripted. `context.md` §4.5 makes `Paragraph` immutable once scripted, and §7.3
  freezes an `AudioScriptChunk` when TTS starts. Therefore:

| Book state | Chapter `PATCH` |
| --- | --- |
| `STRUCTURED`, `ANALYZING`, `ANALYZED`, `NEEDS_REVIEW` | Allowed |
| `CASTING` | Allowed for `title` only |
| `SCRIPTING`, `SCRIPTED`, `GENERATING`, `ASSEMBLING`, `COMPLETED` | `409 CHAPTER_IMMUTABLE_AFTER_SCRIPTING` |

- **Request body:** any subset of `{ "title", "matter_type", "order_index" }`.
- **Response:** `200` with the updated chapter.
- **Status codes:** `200`, `401`, `404`, `409`, `422`.
- **Side effects:** Reordering renumbers sibling `order_index` values transactionally within
  the chapter's `structure_version`. It **does not** rewrite paragraph or scene identity.
  A structural change after analysis has begun does **not** silently invalidate the Story
  Bible; it raises a review flag on the book and the user re-runs `POST .../analysis`
  explicitly (§16.10).
- **Async behavior / Related job:** None. Downstream re-analysis is user-initiated.

#### List sections

`GET /api/v1/books/{bookId}/sections`

- Read-only in v1. Query parameters: `chapter_id`, `structure_version`, §10 pagination.
  Default order `order_index:asc`. `200`, `401`, `404`, `422`.

#### List paragraphs

`GET /api/v1/books/{bookId}/paragraphs`

- **Purpose:** Canonical text units with stable order and `content_hash`
  (`context.md` §4.2 #7) — the unit the Director's chunk text is sliced from.
- **Query parameters:** `chapter_id` (**required** — the whole-book paragraph list is refused
  to prevent a client from paging an entire copyrighted work through a metadata endpoint),
  `scene_id`, `section_id`, `include_text` (boolean, default `true`; when `false`, only
  identifiers, offsets, and hashes are returned), §10 pagination with `limit` max `100`.
- **Response:** `200` collection of
  `{ id, object: "paragraph", chapter_id, section_id, scene_id, order_index, text, content_hash, char_count, structure_version, scripted: true|false }`.
- **Mutation:** None. `PATCH`/`DELETE` are `405`. Correcting text means re-running ingestion
  with a corrected source: `Paragraph` is immutable once scripted, and a text change is a new
  chunk, never an edit (`context.md` §7.3).
- **Status codes:** `200`, `401`, `404`, `422`.

#### Access canonical text

`POST /api/v1/books/{bookId}/text/access-urls` — §16.20. Returns short-lived signed URLs for
the chapter-level canonical text artifacts, which live in object storage rather than the
database (`context.md` §12.1).

---

### 16.9 Scenes

`Scene` has split ownership by design: the Book Service owns the row and its boundaries; the
Context Service owns the semantics stored in the Story Bible (`context.md` §30.2). This API
presents a single **read model** that joins them, and it names the source of each field group
so no client is misled about who may change what.

#### List scenes · Get scene

`GET /api/v1/books/{bookId}/scenes` · `GET /api/v1/books/{bookId}/scenes/{sceneId}`

- **Authorization:** Own tenant.
- **Query parameters:** `chapter_id`, `character_id` (scenes in which the character
  participates), `structure_version`, §10 pagination. Default order: `order_index:asc`.
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9Z4SC0000000000000031",
    "object": "scene",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "chapter_id": "01J9Z4CH0000000000000012",
    "order_index": 3,
    "structure": {
      "source": "book_service",
      "start_paragraph_id": "01J9Z4PG0000000000001200",
      "end_paragraph_id": "01J9Z4PG0000000000001240",
      "paragraph_count": 41,
      "structure_version": "structure.v1"
    },
    "semantics": {
      "source": "story_bible",
      "summary": "Aurelio confronts the keeper about the missing log pages.",
      "participant_character_ids": ["01J9Z4CR0000000000000002", "01J9Z4CR0000000000000005"],
      "location": "The lamp room",
      "in_story_time": "Night, day 3",
      "mood": "TENSE",
      "tension": 0.72,
      "pov_character_id": "01J9Z4CR0000000000000002",
      "narrative_state_snapshot_id": "01J9ZNS00000000000000031",
      "extracted_by_model_version_id": "01J9ZMV0000000000000LLM1",
      "confidence": 0.86
    },
    "created_at": "...", "updated_at": "..."
  }
}
```

- **Constraint surfaced by the contract:** a scene never crosses a chapter boundary in v1
  (`context.md` §4.3). `chapter_id` is therefore always single-valued.
- **Mutation:** None in v1 — `PATCH` is `405`. Scene boundaries are a product of structural
  and narrative analysis; correcting them means re-running `POST .../analysis`. Making scenes
  user-editable is OQ-8 (§24).
- **Status codes:** `200`, `401`, `404`, `422`.

---

### 16.10 Analysis (narrative understanding)

#### Start analysis

`POST /api/v1/books/{bookId}/analysis`

- **Purpose:** Queue narrative understanding: scene segmentation, entity/speaker extraction,
  POV detection, and Story Bible delta accumulation (`context.md` §3.2.7 non-Director
  module, §11.2 `analyze_scene` and `build_story_bible_delta`).
- **Authentication:** Required. **Authorization:** Own tenant.
- **Request headers:** `Idempotency-Key` **required**.
- **Request body:**

```json
{
  "scope": "BOOK",
  "chapter_ids": null,
  "mode": "INCREMENTAL",
  "force": false,
  "priority": "NORMAL"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `scope` | Yes | `BOOK` \| `CHAPTERS` (`chapter_ids[]` required, bounded length) |
| `mode` | Yes | `INCREMENTAL` — continue accumulating in spine order. `REBUILD` — discard derived narrative state for the scope and rebuild it from canonical text. `REBUILD` creates a **new Story Bible snapshot version**; it never mutates an existing snapshot (`context.md` §4.2 #12, §4.5) |
| `force` | No | §11.5 |
| `priority` | No | `context.md` §11.4 |

- **Preconditions:** ingestion `COMPLETED` (or `PARTIAL_OCR` with the user's acknowledgement
  flag on the book) and a current `structure_version`. Otherwise
  `409 INGESTION_NOT_COMPLETE`.
- **Response:** `202` (§7.3).
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** `INGESTION_NOT_COMPLETE` (`409`), `ANALYSIS_ALREADY_RUNNING` (`409`),
  `QUOTA_EXCEEDED` (`429`).
- **Idempotency:** Required.
- **Side effects:** Book state → `ANALYZING`. Emits `book.analysis_completed` on success.
  Produces `Scene` rows, Story Bible deltas, `NarrativeState` snapshots, and **provisional**
  `Character` rows (`context.md` §8.3 — the resolver never invents a character to resolve an
  ambiguity; new identities are created explicitly as `PROVISIONAL` with evidence).
- **Async behavior:** Always, and **sequenced**: narrative analysis advances in spine order
  with per-book concurrency capped by a Redis lock on `book_id` (`context.md` §5.5). The API
  therefore does not accept two concurrent overlapping analysis scopes for one book; the
  second is `409 ANALYSIS_ALREADY_RUNNING`.
- **Related jobs:** `analyze_scene`, `build_story_bible_delta` (`ai` queue).

#### Get analysis state

`GET /api/v1/books/{bookId}/analysis`

- **Response:** `200` with `{ status, mode, scope, spine_position, counts: { scenes,
  characters_provisional, characters_confirmed, snapshots }, story_bible_snapshot_version,
  degraded, degraded_reasons, current_job_id, history[], links }`.
- `degraded: true` is set when any part of the run consumed a degraded context bundle
  (`context.md` §3.2.10) — the client is told that downstream confidence is lower, rather
  than being silently served a weaker result.
- **Status codes:** `200`, `401`, `404`.

---

### 16.11 Characters

The Character Registry owns identity; text surfaces are evidence (`context.md` §8.1).

#### List characters

`GET /api/v1/books/{bookId}/characters`

- **Purpose:** The cast list for casting review (`context.md` §15.2 step 1).
- **Authorization:** Own tenant.
- **Query parameters:** `status` (`CONFIRMED | PROVISIONAL | MERGED_INTO | RETIRED`),
  `speaking` (boolean — has attributed dialogue), `has_voice_assignment` (boolean),
  `include_sentinels` (boolean, default `true`), `sort` (allowlist: `importance_rank`,
  `line_count`, `name`; default `importance_rank:asc`), §10 pagination.
- **Response:** `200` collection of:

```json
{
  "id": "01J9Z4CR0000000000000002",
  "object": "character",
  "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
  "display_name": "Aurelio",
  "status": "CONFIRMED",
  "is_sentinel": false,
  "sentinel_kind": null,
  "importance_rank": 2,
  "line_count": 412,
  "speaking": true,
  "pronoun_sets": [ { "pronouns": "he/him", "valid_from_spine": 0, "valid_to_spine": null } ],
  "speech_traits": { "register": "FORMAL", "verbosity": "TERSE", "dialect_notes": "Coastal", "baseline_emotion": "GUARDED" },
  "first_appearance": { "chapter_id": "01J9Z4CH0000000000000001", "paragraph_id": "01J9Z4PG0000000000000042" },
  "last_appearance": { "chapter_id": "01J9Z4CH0000000000000040", "paragraph_id": "01J9Z4PG0000000000008090" },
  "detection": { "source": "NARRATIVE_UNDERSTANDING", "model_version_id": "01J9ZMV0000000000000LLM1", "confidence": 0.94, "evidence_paragraph_ids": ["01J9Z4PG0000000000000042"] },
  "voice": { "voice_profile_id": "01J9ZVP0000000000000000A", "voice_profile_version": 3, "approval_state": "APPROVED" },
  "merged_into_character_id": null,
  "created_at": "...", "updated_at": "...",
  "links": { "self": "...", "aliases": ".../aliases", "voice": ".../voice" }
}
```

  Reserved sentinels `NARRATOR`, `UNKNOWN_SPEAKER`, `MULTIPLE_SPEAKERS`, `SYSTEM` exist for
  every book (`context.md` §8.2) and are returned with `is_sentinel: true`. They cannot be
  renamed, merged, or deleted: `409 SENTINEL_CHARACTER_IMMUTABLE`.

- **Character detection status** is the `status` field plus the `detection` block; there is
  no separate detection-status endpoint. Whether detection has finished for the book is
  `GET .../analysis` (§16.10).
- **Status codes:** `200`, `401`, `404`, `422`.

#### Get character

`GET /api/v1/books/{bookId}/characters/{characterId}` — `200`, `304`, `401`, `404`.

#### Update character

`PATCH /api/v1/books/{bookId}/characters/{characterId}`

- **Purpose:** User correction of automatic detection. **Corrections are supported** — cast
  review is a mandatory human gate (`context.md` §15.2 step 2), so the contract must allow
  confirm, rename, and mark-non-speaking.
- **Authorization:** Own tenant.
- **Request body:** any subset of
  `{ "display_name", "status", "importance_rank", "speaking", "pronoun_sets", "speech_traits" }`.
  `status` may be set only to `CONFIRMED` or `RETIRED` — `MERGED_INTO` is set exclusively by
  a merge command (§below) and `PROVISIONAL` is set only by detection.
- **Response:** `200` with the updated character.
- **Status codes:** `200`, `401`, `404`, `409`, `422`.
- **Errors:** `SENTINEL_CHARACTER_IMMUTABLE` (`409`), `INVALID_STATE_TRANSITION` (`409`).
- **Downstream invalidation (binding).** Editing identity metadata does **not** rewrite
  generated artifacts. It:
  1. invalidates the character-resolution cache for the book (`context.md` §8.3);
  2. marks affected `AudioScriptChunk`s in state `DRAFT`/`VALIDATED` as requiring
     re-direction (they become `DRAFT` with `review_flags += "CHARACTER_METADATA_CHANGED"`);
  3. leaves **frozen** chunks and all generated `AudioChunk`s untouched and valid;
  4. sets `book.needs_review_count += n` and reports the impact in the response as
     `data.impact` (see below).
  Re-directing or re-rendering is always an explicit subsequent request (§16.13, §16.15).
  Nothing is regenerated as a side effect of an edit.

```json
{
  "data": {
    "id": "01J9Z4CR0000000000000002",
    "object": "character",
    "impact": {
      "audio_script_chunks_reopened": 0,
      "audio_script_chunks_frozen_unchanged": 268,
      "audio_chunks_unaffected": 268,
      "requires_director_rerun": false
    }
  }
}
```

#### Aliases

`GET|POST /api/v1/books/{bookId}/characters/{characterId}/aliases`
`PATCH|DELETE /api/v1/books/{bookId}/characters/{characterId}/aliases/{aliasId}`

- **Purpose:** Manage surface forms (`context.md` §8.2), including **validity ranges** along
  the spine and **scoped** aliases.
- **Authorization:** Own tenant.
- **Request body (create/update):**

```json
{
  "surface_form": "the Queen",
  "alias_type": "TITLE",
  "valid_from_spine": 4120,
  "valid_to_spine": null,
  "scope": { "kind": "GLOBAL", "chapter_id": null, "speaker_character_id": null }
}
```

| Field | Notes |
| --- | --- |
| `alias_type` | `GIVEN_NAME` \| `FULL_NAME` \| `SURNAME` \| `NICKNAME` \| `TITLE` \| `EPITHET` \| `DESCRIPTOR` \| `RELATIONAL` (`context.md` §8.2 — closed) |
| `scope.kind` | `GLOBAL` \| `CHAPTER` \| `SPEAKER` — "what Ben calls Alice" is `SPEAKER` with `speaker_character_id` |
| `valid_from_spine` / `valid_to_spine` | Integer spine positions or `null`; `from <= to` or `422` / `inconsistent_with` |

- **Responses:** `201` (create, `Location`), `200` (update), `204` (delete).
- **Status codes:** `200`/`201`/`204`, `401`, `404`, `409`, `422`.
- **Errors:** `ALIAS_CONFLICT` (`409`) when the same surface form, scope, and overlapping
  validity range already resolves to a different character — the system refuses to create an
  ambiguity rather than picking a winner (`context.md` §8.3).
- **Side effects:** Invalidates the per-book resolution cache. Same downstream invalidation
  rules as a character edit.

#### Merge and split characters

`POST /api/v1/books/{bookId}/character-merges`

- **Purpose:** Record that two provisional identities are one person, or that one identity
  must be split (`context.md` §8.4).
- **Authorization:** Own tenant. **Idempotency-Key required.**
- **Request body:**

```json
{
  "operation": "MERGE",
  "losing_character_id": "01J9Z4CR0000000000000007",
  "winning_character_id": "01J9Z4CR0000000000000002",
  "voice_conflict_resolution": null,
  "rebind_scope": "AFFECTED_CHUNKS_ONLY"
}
```

| Field | Notes |
| --- | --- |
| `operation` | `MERGE` \| `SPLIT` |
| `voice_conflict_resolution` | Required **only** when the two identities carry different voice assignments. `null` in that case is `409 VOICE_ASSIGNMENT_CONFLICT` with both assignments in `details` — the system does not pick (`context.md` §8.4 step 5) |
| `rebind_scope` | `AFFECTED_CHUNKS_ONLY` (the only value in v1). Named explicitly so the contract records that a merge never re-renders a whole book |

- **Response:** `202` with a job handle, plus an impact set:

```json
{
  "data": {
    "job": { "id": "01J9ZJOBMERGE00000000001", "object": "job", "type": "revise_director_ir", "status": "QUEUED", "book_id": "01J9Z2K..." },
    "accepted": {
      "scope": "AFFECTED_CHUNKS_ONLY",
      "draft_chunks_rebound_in_place": 41,
      "generated_chunks_to_reversion": 12,
      "chapters_affected": ["01J9Z4CH0000000000000012"],
      "planned_unit_count": 12,
      "skipped_unit_count": 0
    }
  }
}
```

- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** `VOICE_ASSIGNMENT_CONFLICT` (`409`), `SENTINEL_CHARACTER_IMMUTABLE` (`409`),
  `INVALID_STATE_TRANSITION` (`409`) when the losing character is already merged.
- **Side effects (binding, from `context.md` §8.4):** the losing row is **retained** with
  `status: "MERGED_INTO"` and `merged_into_character_id` set — merges are auditable and
  reversible at the record level. Aliases move to the winner. Chunks not yet generated are
  re-bound in place while still `DRAFT`. Chunks already generated are **re-versioned**, and
  only the affected chunks are re-queued — never the whole book. Emits `character.merged`.
- **Async behavior:** Always. The response's `accepted` block is the impact set, not a
  completion claim.
- **Related jobs:** `revise_director_ir`, then `generate_tts_chunk` for the re-versioned
  chunks.

`GET /api/v1/books/{bookId}/character-merges` lists the merge history (`200`, paginated,
default `created_at:desc`) so a user can audit and, where the record permits, reverse a
merge.

---

### 16.12 Story Bible

The Story Bible is a knowledge store with a retrieval API; it does not think and it does not
generate (`context.md` §5.1). The public API exposes **what it knows**, not how it was
prompted: no prompt text, no bundle internals, no model instruction is ever returned.

#### Get the Story Bible

`GET /api/v1/books/{bookId}/story-bible`

- **Purpose:** The book's accumulated narrative knowledge, with version and freshness
  information.
- **Authentication:** Required. **Authorization:** Own tenant.
- **Query parameters:**

| Name | Default | Notes |
| --- | --- | --- |
| `sections` | `summary` | Comma-separated allowlist: `summary`, `characters`, `relationships`, `locations`, `timeline`, `objects`, `factions`, `perspective`, `unresolved`. Large sections are separately paginated by their own endpoints where they exist |
| `snapshot_version` | current | Read a historical snapshot version (`context.md` §4.2 #12 snapshot-versioned) |

- **Response:** `200`

```json
{
  "data": {
    "object": "story_bible",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "status": "READY",
    "current_snapshot_version": 7,
    "generated_snapshot_version": 7,
    "generated_by": {
      "model_version_id": "01J9ZMV0000000000000LLM1",
      "pipeline_version": "pipeline.v1",
      "structure_version": "structure.v1",
      "source_content_hash": "9f2c...e1"
    },
    "coverage": { "chapters_analyzed": 40, "chapters_total": 40, "spine_position": 8123 },
    "stale": false,
    "stale_reasons": [],
    "degraded": false,
    "last_updated_at": "2026-08-27T12:40:00.000Z",
    "sections": {
      "summary": {
        "genre": "Adventure",
        "tone": "Sombre",
        "pov_type": "THIRD_LIMITED",
        "narrator_character_ids": ["01J9Z4CR000000000000NARR"],
        "character_count": 23,
        "location_count": 11,
        "timeline_event_count": 96
      }
    },
    "links": { "self": "...", "snapshots": ".../snapshots", "pronunciations": ".../pronunciations" }
  }
}
```

- **Story Bible status (§20.7):** `NOT_BUILT | BUILDING | READY | STALE | FAILED`.
  `stale: true` with `stale_reasons[]` (`STRUCTURE_CHANGED`, `CHARACTERS_MERGED`,
  `SOURCE_TEXT_CHANGED`) is how the API says "rebuild is advisable" without rebuilding
  anything by itself.
- **What is deliberately not exposed:** prompts, prompt templates, context bundles, bundle
  hashes as retrievable content, token budgets, retrieval scores, embedding vectors, and raw
  model responses. `context_bundle_hash` appears **as an opaque identifier only**, on Director
  artifacts, for lineage correlation (§16.13).
- **Status codes:** `200`, `401`, `404`, `422`.

#### Rebuild behavior

There is **no** `POST /story-bible` endpoint. Rebuilding the Story Bible is
`POST /api/v1/books/{bookId}/analysis` with `mode: "REBUILD"` (§16.10), because the Story
Bible is written by the narrative-understanding stage and the architecture gives it no
independent generation capability (`context.md` §3.2.10: "is not an LLM; performs no
generation"). Creating a second command path to the same work would violate §4.3.

A rebuild produces a **new snapshot version**; the previous snapshot remains readable at
`?snapshot_version=`, and artifacts that referenced it stay explainable.

#### List and read narrative snapshots

`GET /api/v1/books/{bookId}/story-bible/snapshots`
`GET /api/v1/books/{bookId}/story-bible/snapshots/{snapshotId}`

- **Purpose:** `NarrativeState` snapshots at scene and chapter boundaries — the mechanism
  that makes the Director resumable mid-book (`context.md` §5.3).
- **Query parameters:** `chapter_id`, `scene_id`, `snapshot_version`, §10 pagination.
  Default order `spine_position:asc`.
- **Response:** `200` collection of
  `{ id, object: "narrative_state", book_id, chapter_id, scene_id, spine_position,
  snapshot_version, present_character_ids[], pov_character_id, mood, unresolved_threads[],
  model_version_id, created_at }`.
- **Mutation:** none — `NarrativeState` is immutable (`context.md` §4.5). `PATCH` is `405`.
- **Status codes:** `200`, `401`, `404`, `422`.

#### Pronunciation lexicon

`GET|POST /api/v1/books/{bookId}/story-bible/pronunciations`
`PATCH|DELETE /api/v1/books/{bookId}/story-bible/pronunciations/{entryId}`

- **Purpose:** The book-scoped canonical pronunciation lexicon, which `context.md` §6.4
  explicitly makes **user-editable**.
- **Authorization:** Own tenant.
- **Request body (create/update):**

```json
{
  "surface_form": "Aurelio",
  "ipa": "aʊˈɾeljo",
  "lexicon_key": "aurelio_given",
  "applies_to": "GLOBAL",
  "notes": null
}
```
  Exactly one of `ipa` or a reference to an existing `lexicon_key` is required. IPA is
  validated against the IPA character set; an invalid symbol is `422` / `invalid_format`.
  **Pronunciation is never encoded by mangling display text** (`context.md` §6.4) — there is
  no endpoint that edits `text` to change how something is spoken.
- **Responses:** `201` / `200` / `204`.
- **Side effects and invalidation:** A lexicon change affects **future** Director output. It:
  1. does not modify any existing `AudioScriptChunk` (frozen chunks are untouchable, §7.3);
  2. marks chunks in `DRAFT`/`VALIDATED` that reference the affected surface form with
     `review_flags += "PRONUNCIATION_LEXICON_CHANGED"`;
  3. reports an `impact` block identical in shape to §16.11;
  4. triggers **nothing**. Re-directing and re-rendering are explicit user actions.
- **Status codes:** `200`/`201`/`204`, `401`, `404`, `409`, `422`.
- **Errors:** `PRONUNCIATION_ENTRY_CONFLICT` (`409`) on a duplicate `surface_form` +
  `applies_to`.
---

### 16.13 Director and Audio Script IR

The Director decides *how every span is performed* and is forbidden from executing those
decisions (`context.md` §6.1, §6.5). The API mirrors that split exactly: the Director
endpoint starts a job, and the Audio Script endpoints read the resulting contract.

#### Start Director processing

`POST /api/v1/books/{bookId}/director`

- **Purpose:** Queue generation of Audio Script IR for a scope. **The operation is
  asynchronous. It never claims success because a job was accepted.**
- **Authentication:** Required. **Authorization:** Own tenant.
- **Request headers:** `Idempotency-Key` **required**.
- **Path parameters:** `bookId`.
- **Query parameters:** —
- **Request body:**

```json
{
  "scope": "CHAPTERS",
  "chapter_ids": ["01J9Z4CH0000000000000012"],
  "scene_ids": null,
  "chunk_ids": null,
  "director_version": "director.v3",
  "force": false,
  "priority": "NORMAL"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `scope` | Yes | `BOOK` \| `CHAPTERS` \| `SCENES` \| `CHUNKS`. Exactly one matching id array must be present |
| `director_version` | No | Defaults to the platform's current Director version. Naming an older version is permitted only if it is still registered; an unknown value is `422` / `invalid_enum`. It identifies the **whole decision bundle** — prompts, post-processing, validation rules, and the LLM `ModelVersion` (`context.md` §6.6) |
| `force` | No | §11.5 |
| `priority` | No | `context.md` §11.4 |

- **Preconditions, checked before acceptance:**
  1. Ingestion `COMPLETED` and a current `structure_version` — else `409
     INGESTION_NOT_COMPLETE`.
  2. Analysis has produced `NarrativeState` snapshots covering the scope — else
     `409 ANALYSIS_NOT_COMPLETE`. Sequential accumulation ordering (`context.md` §5.5) is why
     the Director cannot run ahead of analysis.
  3. **Mixed Director versions are refused by default** (`context.md` §6.6): if the book
     already has `AudioScript` content at a different `director_version` and the request would
     produce a mixed audiobook, the response is `409 DIRECTOR_VERSION_MIXING_FORBIDDEN`
     unless the body carries `"acknowledge_version_mixing": true`, which is recorded as an
     explicit user decision on the book.
- **Response:** `202` (§7.3)

```json
{
  "data": {
    "job": { "id": "01J9ZJOBDIR0000000000001", "object": "job", "type": "generate_director_ir", "status": "QUEUED", "book_id": "01J9Z2K...", "links": { "self": "/api/v1/jobs/01J9ZJOBDIR0000000000001" } },
    "accepted": {
      "scope": "CHAPTERS",
      "chapter_ids": ["01J9Z4CH0000000000000012"],
      "director_version": "director.v3",
      "input_structure_version": "structure.v1",
      "input_story_bible_snapshot_version": 7,
      "input_content_hash": "9f2c...e1",
      "planned_unit_count": 214,
      "skipped_unit_count": 0
    }
  }
}
```

  `accepted` names the **input versions**; the **output version** (`audio_script_id` and its
  `version`) does not exist yet and is therefore absent. It appears on the job's `result`
  when the job reaches `SUCCEEDED`, and on `GET .../director`.
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** `INGESTION_NOT_COMPLETE`, `ANALYSIS_NOT_COMPLETE`,
  `DIRECTOR_VERSION_MIXING_FORBIDDEN`, `DIRECTOR_ALREADY_RUNNING` (all `409`);
  `VALIDATION_FAILED` (`422`); `QUOTA_EXCEEDED` (`429`).
- **Idempotency:** Required. Job key:
  `director:{chunk_scope_id}:{content_hash}:{director_version}:{context_bundle_hash}`
  (`context.md` §16.3).
- **Side effects:** Book state → `SCRIPTING`. Emits `director.started`, then
  `director.chunk_completed` per chunk, then `director.completed` or `director.failed`
  (`context.md` §11.3).
- **Async behavior:** Always. `accepted` is not a result. **Accepted ≠ completed**: a client
  determines completion only from `GET /jobs/{jobId}.status == "SUCCEEDED"` or from
  `GET .../director.status == "COMPLETED"`, and never from the `202`.
- **Related jobs:** `generate_director_ir`, `revise_director_ir` (`ai` queue).

#### Get Director state

`GET /api/v1/books/{bookId}/director`

- **Purpose:** Processing status, versions, validation summary, and the current output
  pointer.
- **Response:** `200`

```json
{
  "data": {
    "object": "director_state",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "status": "COMPLETED",
    "director_version": "director.v3",
    "director_model_version_id": "01J9ZMV0000000000000LLM1",
    "input_versions": {
      "structure_version": "structure.v1",
      "story_bible_snapshot_version": 7,
      "source_content_hash": "9f2c...e1"
    },
    "output": {
      "audio_script_id": "01J9ZAS00000000000000001",
      "audio_script_version": 2,
      "schema_version": "ir.v1.2",
      "chunk_count": 8420,
      "coverage_verified": true
    },
    "validation": {
      "status": "PASSED",
      "unknown_speaker_rate": 0.004,
      "fallback_applied_count": 11,
      "low_confidence_chunk_count": 37,
      "coverage_gaps": 0,
      "coverage_overlaps": 0
    },
    "degraded": false,
    "current_job_id": null,
    "completed_at": "2026-08-27T14:05:00.000Z",
    "history": [ { "job_id": "01J9ZJOBDIR0000000000001", "status": "SUCCEEDED", "director_version": "director.v3", "completed_at": "2026-08-27T14:05:00.000Z" } ],
    "links": { "audio_script": "/api/v1/books/01J9Z2K.../audio-script", "chunks": "/api/v1/books/01J9Z2K.../audio-script-chunks" }
  }
}
```

- **Director state vocabulary (§20.5):** `NOT_STARTED | QUEUED | RUNNING | VALIDATING |
  COMPLETED | NEEDS_REVIEW | FAILED | CANCELLED`. `COMPLETED` is set only after IR validation
  passed (`context.md` §14.2), including the **coverage invariant**: the concatenation of
  chunk `text` for a chapter reconstructs the chapter's canonical text exactly, modulo
  declared `spoken_text` substitutions. `coverage_verified: false` with `status: COMPLETED`
  is impossible and would be a contract violation.
- **Status codes:** `200`, `401`, `404`.

#### Get current Audio Script · list versions

`GET /api/v1/books/{bookId}/audio-script`
`GET /api/v1/books/{bookId}/audio-scripts`
`GET /api/v1/books/{bookId}/audio-scripts/{audioScriptId}`

- **Purpose:** The `AudioScript` parent: scope, Director configuration, model versions, chunk
  manifest totals (`context.md` §7.2).
- **Query parameters (list):** `include_superseded` (default `false`), `chapter_id`, §10
  pagination, default order `version:desc`.
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZAS00000000000000001",
    "object": "audio_script",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "scope": "BOOK",
    "version": 2,
    "supersedes_audio_script_id": "01J9ZAS00000000000000000",
    "schema_version": "ir.v1.2",
    "director_version": "director.v3",
    "director_model_version_id": "01J9ZMV0000000000000LLM1",
    "source_content_hash": "9f2c...e1",
    "story_bible_snapshot_version": 7,
    "chunk_count": 8420,
    "totals": { "characters": 1842113, "estimated_audio_ms": 43200000 },
    "state": "VALIDATED",
    "created_at": "...", "updated_at": "...",
    "links": { "self": "...", "chunks": "/api/v1/books/01J9Z2K.../audio-script-chunks?audio_script_id=01J9ZAS00000000000000001" }
  }
}
```

- **Mutation:** none. `AudioScript` is immutable (`context.md` §4.2 #14). `PATCH`/`DELETE`
  are `405`.
- **Status codes:** `200`, `401`, `404`, `422`.

#### List Audio Script chunks

`GET /api/v1/books/{bookId}/audio-script-chunks`

- **Purpose:** Chapter-, scene-, and chunk-level retrieval of the IR (`context.md` §7.2).
  This is the endpoint a review UI reads.
- **Authorization:** Own tenant.
- **Query parameters:**

| Name | Notes |
| --- | --- |
| `audio_script_id` | Defaults to the current `AudioScript` |
| `chapter_id`, `scene_id`, `section_id` | Scope filters |
| `character_id` | Chunks bound to a character |
| `speaker_type` | `NARRATOR` \| `CHARACTER` \| `UNKNOWN` \| `SYSTEM` |
| `state` | `DRAFT` \| `VALIDATED` \| `LOCKED` \| `SUPERSEDED` (`context.md` §4.4) |
| `has_review_flags` | boolean |
| `fallback_applied` | boolean |
| `min_confidence`, `max_confidence` | float bounds |
| `include_superseded` | default `false` |
| `sort` | Allowlist: `sequence_index`, `confidence`. Default `sequence_index:asc` |
| `limit`, `cursor`, `before`, `include_total` | §10 |

- **Response:** `200` collection of chunk resources (below).
- **Status codes:** `200`, `401`, `404`, `422`.

#### Get an Audio Script chunk

`GET /api/v1/books/{bookId}/audio-script-chunks/{chunkId}`

- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZASC000000000000A001",
    "object": "audio_script_chunk",
    "audio_script_id": "01J9ZAS00000000000000001",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "chapter_id": "01J9Z4CH0000000000000012",
    "section_id": "01J9Z4SE0000000000000031",
    "scene_id": "01J9Z4SC0000000000000031",
    "sequence_index": 4021,
    "chapter_sequence_index": 118,
    "state": "LOCKED",
    "supersedes_chunk_id": null,
    "source_paragraph_ids": ["01J9Z4PG0000000000001211"],
    "source_content_hash": "3c81...aa",
    "schema_version": "ir.v1.2",
    "director_version": "director.v3",
    "director_model_version_id": "01J9ZMV0000000000000LLM1",
    "context_bundle_hash": "b71f...09",
    "content": {
      "text": "\"You will not take the log,\" said Aurelio.",
      "spoken_text": null,
      "spoken_text_substitutions": null,
      "language": "en-GB",
      "script": null
    },
    "performance": {
      "speaker_type": "CHARACTER",
      "character_id": "01J9Z4CR0000000000000002",
      "is_dialogue": true,
      "delivery_mode": "NORMAL",
      "emotion": "ANGRY",
      "emotion_intensity": 0.7,
      "pacing": 0.95,
      "pitch": 0.0,
      "volume": 0.1,
      "pauses": [ { "position": "TRAILING", "offset_chars": null, "duration_ms": 420 } ],
      "emphasis": [ { "offset_chars": 5, "length_chars": 8, "strength": 0.6 } ],
      "pronunciation_hints": [ { "offset_chars": 31, "length_chars": 7, "ipa": null, "lexicon_key": "aurelio_given" } ],
      "non_verbal": []
    },
    "voice_binding": {
      "voice_profile_id": "01J9ZVP0000000000000000A",
      "voice_profile_version": 3
    },
    "generation_control": {
      "tts_provider_id": "xtts-v2",
      "generation_params_hash": "77aa...31",
      "seed": 8123471,
      "target_sample_rate": 24000,
      "target_channels": 1
    },
    "quality": {
      "confidence": 0.91,
      "decision_confidence": null,
      "review_flags": [],
      "fallback_applied": false,
      "fallback_reason": null,
      "capability_gaps": [],
      "continuity": null
    },
    "provenance": {
      "origin": "AUTO_GENERATED",
      "director_original": null,
      "override": null
    },
    "audio": {
      "current_audio_chunk_id": "01J9ZAC000000000000A0011",
      "status": "VALIDATED"
    },
    "created_at": "...", "updated_at": "...",
    "links": { "self": "...", "audio_chunks": "/api/v1/books/01J9Z2K.../audio-chunks?audio_script_chunk_id=01J9ZASC000000000000A001" }
  }
}
```

  `voice_reference` (the resolved object key for the embedding or reference audio) is present
  in the IR that the worker receives but is **never** returned to a public client: it is an
  object-storage key (§14.8).
- **Status codes:** `200`, `304`, `401`, `404`.

> **Correction (architecture-review.md §3, §56; `audio-script-ir.md` §63.2 IR-6/IR-10/IR-11/IR-12/IR-13).**
> This resource previously omitted six fields `audio-script-ir.md` specifies as additive on
> `AudioScriptChunk`, and — separately — used `"emotion": "ANGER"`, not a member of the
> 17-item `emotion` vocabulary (the member is `ANGRY`; same defect as the §16.14 correction
> above). Both are fixed above. New fields, matching `audio-script-ir.md`'s field names and
> `database-schema.md` §13.2's columns exactly:
> - `content.spoken_text_substitutions` — the documented, reversible substitution list behind
>   `spoken_text`, `null` when `spoken_text` is `null`.
> - `performance.non_verbal` — offset-scoped non-verbal annotations (`LAUGH`/`SIGH`/etc.);
>   always present as an array, `[]` when empty, exactly like `pauses`/`emphasis`.
> - `quality.decision_confidence` — optional per-decision confidence breakdown, `null` unless
>   populated; distinct from the single required `quality.confidence`.
> - `quality.continuity` — optional performance-continuity metadata carried forward from the
>   Director's context assembly, `null` unless populated.
> - **`provenance`** — a new field group: `origin` (`AUTO_GENERATED` \| `HUMAN_REVIEWED` \|
>   `HUMAN_MODIFIED` \| `LOCKED`), `director_original` (only the human-changed fields, at their
>   original Director-produced values — `null` until a human edits the chunk, and never
>   overwritten by a second edit), and `override` (`{modified_by_user_id, modified_at, reason}`,
>   `null` until a human edits the chunk). This closes the gap `audio-script-ir.md` §32.2 named:
>   an in-place `PATCH` on this resource (§16.13 below) previously had no field recording that a
>   human, not the Director, produced the live value — silently destroying the original
>   decision. `PATCH` on a `DRAFT`/`VALIDATED` chunk now sets `origin=HUMAN_MODIFIED` and
>   populates `director_original` with the pre-edit values of exactly the fields the request
>   changed, the first time the chunk is edited; a second `PATCH` updates the live fields again
>   but does **not** overwrite an already-recorded `director_original` ("first original wins").
>   No client should branch on `origin` when rendering or requesting generation — the live
>   fields above always hold the single resolved value; `provenance` exists for audit display
>   only.

#### Update an Audio Script chunk

`PATCH /api/v1/books/{bookId}/audio-script-chunks/{chunkId}`

- **Purpose:** Let a user correct a performance decision — the "fix one line without
  invalidating a 14-hour render" case (`context.md` §7.3).
- **Decision: the IR is editable, but only within the mutability contract of `context.md`
  §7.3.** Editability is not a convenience; it is bounded by the freeze rule.

| Field group | Editable? |
| --- | --- |
| Identity, lineage, `source_content_hash`, `schema_version`, `director_version`, `context_bundle_hash` | **Never.** `422` / `immutable` |
| `content.text`, `content.spoken_text`, `content.language` | **Never via this endpoint.** A text change is a new chunk, not an edit (`context.md` §7.3). `422` / `immutable` |
| `performance.*`, `voice_binding.*`, `generation_control.*` (params, seed) | Editable **only** while `state` is `DRAFT` or `VALIDATED` |
| `quality.review_flags` | Editable — annotations, not contract. A user may clear a flag they have reviewed |
| `provenance.*` | **Never directly settable by the caller.** The server writes it as a side effect of an edit — see below |

- **Request body:** any subset of the editable groups. Values are validated against the
  closed vocabularies (`context.md` §6.3) and the bounded ranges; pause offsets must lie
  within the text; emphasis spans must be in bounds and non-overlapping (`context.md` §14.2).
- **Response:** `200` with the updated chunk **or**, when the chunk was `LOCKED`, `409`.
- **Status codes:** `200`, `401`, `404`, `409`, `422`.
- **Errors:**
  - `AUDIO_SCRIPT_CHUNK_FROZEN` (`409`) — the chunk is `LOCKED` because a `TTSJob` for it
    entered `RUNNING` (`context.md` §7.3). The message directs the caller to
    `POST .../tts` with `scope: "CHUNKS"` and `force: true`, which creates a **new chunk
    version** with `supersedes` set rather than editing the frozen one.
  - `VOICE_PROFILE_NOT_APPROVED` (`409`) — rebinding to a version that is not `APPROVED`.
  - `VALIDATION_FAILED` (`422`).
- **Idempotency:** `PATCH` is idempotent by method.
- **Versioning and invalidation (binding):**
  - Editing a `DRAFT`/`VALIDATED` chunk mutates it in place and re-runs chunk validation;
    `state` returns to `DRAFT` until validation passes.
  - Editing is **never** possible after freeze. The supersede path creates chunk `n+1` with
    `supersedes = n`; downstream `AudioChunk`s for version `n` are marked `SUPERSEDED` and
    **retained** (`context.md` §2.5, §7.3); the chapter manifest then references the new
    version, and only the affected chapter is re-assembled.
  - **An edit preserves the Director's original decision — it never destroys it**
    (`audio-script-ir.md` IR-11, closing a gap this endpoint previously had). The **first**
    time any `performance.*`/`voice_binding.*`/`generation_control.*` field on a given chunk is
    edited, the server sets `provenance.origin = "HUMAN_MODIFIED"` and writes the **pre-edit**
    values of exactly the changed fields into `provenance.director_original` — never a full
    snapshot, and never overwritten by a later edit to the same chunk ("first original wins": a
    second `PATCH` updates the live fields again but leaves `director_original` holding the
    Director's own original value, not the first human's). `provenance.override` is set/updated
    to `{modified_by_user_id, modified_at, reason}` on every human edit, where `reason` is
    optional free text supplied by the caller and is treated as **untrusted input** like any
    other user-supplied string. A response body whose fields were never edited by a human keeps
    `provenance.origin = "AUTO_GENERATED"` and `provenance.director_original = null`. No
    consumer of this resource — including the render path — branches on `provenance.origin`;
    the live `performance`/`voice_binding`/`generation_control` fields always hold the single
    resolved value to be rendered, exactly as before this correction.
- **Side effects:** May set `book.needs_review_count`. Never enqueues generation by itself —
  rendering is always an explicit `POST .../tts`. Writes an `audit_log` row
  (`action = "audio_script_chunk.human_modified"`, `database-schema.md` §17.1) independently of
  `provenance`, matching the human-override audit discipline already applied to voice and
  casting decisions elsewhere in this document.
- **Async behavior / Related job:** None for the edit itself.

---

### 16.14 Voice profiles, versions, previews, casting, and assignment

`context.md` §9.1 states the consistency guarantee this section exists to protect:
*Character A in chapter 1 and Character A in chapter 20 MUST resolve to the same
`VoiceProfileVersion`, unless the user explicitly created and approved a new version.*

#### Scope model

`VoiceProfile` is **tenant-scoped** (`context.md` §19.1: a tenant-scoped library with
book-scoped assignments), while `context.md` §4.3 also draws `Book ─1:N─ VoiceProfile`. This
document reconciles the two with an explicit `scope` field (OQ-1, §24):

| `scope` | Meaning | Reachable at |
| --- | --- | --- |
| `TENANT` | Library profile, reusable across the tenant's books | `/api/v1/voice-profiles` |
| `BOOK` | Profile created for one book; carries `book_id` | `/api/v1/voice-profiles` and `/api/v1/books/{bookId}/voice-profiles` |
| `SYSTEM` | Read-only system library (`context.md` §19.1) | `/api/v1/voice-profiles?scope=SYSTEM` |

Using a `SYSTEM` voice **creates a tenant-scoped version snapshot** so a system-library
update can never alter an existing audiobook (`context.md` §19.1). The API surfaces this: a
`PUT .../voice` assignment naming a `SYSTEM` profile responds with the *snapshotted*
tenant-scoped profile and version it actually bound.

#### List and create voice profiles

`GET /api/v1/voice-profiles` · `POST /api/v1/voice-profiles`

- **Authorization:** Own tenant. `SYSTEM` profiles are readable by all tenants and writable
  by none (`403 FORBIDDEN` on any mutation).
- **Query parameters (list):** `scope`, `book_id`, `language`, `tts_provider_id`,
  `approval_state` (of the active version), `sort` (`name`, `created_at`; default `name:asc`),
  §10 pagination.
- **Request body (create):**

```json
{
  "name": "Aurelio",
  "description": "Weathered, low, coastal accent",
  "scope": "BOOK",
  "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
  "intended_character_ids": ["01J9Z4CR0000000000000002"]
}
```
  `book_id` is required when `scope: "BOOK"` and forbidden otherwise (`422` /
  `inconsistent_with`).
- **Response:** `201`, `Location`.

```json
{
  "data": {
    "id": "01J9ZVP0000000000000000A",
    "object": "voice_profile",
    "tenant_id": "01J9Z0TEN00000000000000001",
    "scope": "BOOK",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "name": "Aurelio",
    "description": "Weathered, low, coastal accent",
    "active_version": 3,
    "lock_state": "LOCKED",
    "version_count": 3,
    "created_at": "...", "updated_at": "...",
    "links": { "self": "...", "versions": ".../versions" }
  }
}
```

- **Status codes:** `200`/`201`, `401`, `403`, `404`, `409`, `422`.
- **Idempotency:** Optional but honored.

#### Get, update, delete a voice profile

`GET|PATCH|DELETE /api/v1/voice-profiles/{voiceProfileId}`

- **`PATCH`** edits `name`, `description`, `intended_character_ids` only. It **cannot** change
  `active_version` — activation happens through approval and assignment. `scope` and
  `book_id` are immutable.
- **`DELETE`** is a soft delete and is refused with `409 VOICE_PROFILE_IN_USE` if any version
  is `LOCKED` or is referenced by retained audio. A profile that produced an audiobook is
  never removable; it is retired (`context.md` §9.2 — `RETIRED` never means deleted).
- **Status codes:** `200`/`204`, `401`, `403`, `404`, `409`, `422`.

#### List and create voice profile versions

`GET /api/v1/voice-profiles/{voiceProfileId}/versions`
`POST /api/v1/voice-profiles/{voiceProfileId}/versions`

- **Purpose:** A `VoiceProfileVersion` is the concrete renderable voice
  (`context.md` §9.2). **Every parameter change creates a new version**; nothing is edited in
  place.
- **Authorization:** Own tenant. **Idempotency-Key required** on create.
- **Request body (create):**

```json
{
  "tts_provider_id": "xtts-v2",
  "tts_model_id": "xtts_v2",
  "tts_model_version_id": "01J9ZMV0000000000000TTS1",
  "language": "en-GB",
  "supported_languages": ["en-GB", "en-US"],
  "base_generation_params": { "speed": 1.0, "temperature": 0.7, "top_k": 50, "exaggeration": 0.3 },
  "default_pitch": 0.0,
  "default_volume": 0.0,
  "default_pacing": 1.0,
  "derive_from_version": 2,
  "reference_audio_consent": {
    "attested": true,
    "subject": "SYNTHETIC",
    "attestation_text": "No real person's voice is cloned by this profile."
  }
}
```

| Field | Notes |
| --- | --- |
| `tts_provider_id` | A **provider abstraction id**, never a hostname or worker address (`context.md` §7.2) |
| `derive_from_version` | Optional. Copies parameters from an existing version as a starting point; the new version still gets its own monotonic number and `supersedes` pointer |
| `reference_audio_consent` | **Mandatory** (`context.md` §9.3.6). `subject` is `SYNTHETIC` \| `SELF` \| `THIRD_PARTY_CONSENTED`. Voice cloning of a real person without an attestation is refused at this boundary with `422 CONSENT_ATTESTATION_REQUIRED`. `THIRD_PARTY_CONSENTED` requires `attestation_text` |

- **Response:** `201`, `Location`

```json
{
  "data": {
    "id": "01J9ZVPV000000000000000C",
    "object": "voice_profile_version",
    "voice_profile_id": "01J9ZVP0000000000000000A",
    "version": 4,
    "supersedes_version": 3,
    "approval_state": "DRAFT",
    "lock_state": "UNLOCKED",
    "locked_at": null,
    "locked_reason": null,
    "tts_provider_id": "xtts-v2",
    "tts_model_version_id": "01J9ZMV0000000000000TTS1",
    "language": "en-GB",
    "supported_languages": ["en-GB", "en-US"],
    "base_generation_params": { "speed": 1.0, "temperature": 0.7, "top_k": 50, "exaggeration": 0.3 },
    "base_generation_params_hash": "77aa...31",
    "speaker_reference": {
      "has_reference_audio": false,
      "reference_audio_content_hash": null,
      "has_embedding": false,
      "embedding_extractor_model_version_id": null
    },
    "emotion_capability_map": { "ANGRY": "NATIVE", "GRIEF": "APPROXIMATED", "PLAYFUL": "UNSUPPORTED" },
    "consent": { "attested": true, "subject": "SYNTHETIC" },
    "preview_count": 0,
    "created_by": "01J9Z0USR00000000000000001",
    "created_at": "...", "updated_at": "...",
    "links": { "self": "...", "previews": ".../previews", "approval": ".../approval", "lock": ".../lock" }
  }
}
```

> **Correction (architecture-review.md §3, §56; `tts-provider-specification.md` TTS-1).** The
> example above previously keyed `emotion_capability_map` with `"ANGER"` — not a member of the
> 17-item `emotion` vocabulary `director-specification.md` §4.1 fixes (the member is
> `ANGRY`) — and with `"WHISPER"`/`"SINGING"`, which are `delivery_mode` members
> (`context.md` §6.2), not `emotion` members. `emotion_capability_map` is scoped **strictly**
> to the `emotion` vocabulary, per `context.md` §9.2 and confirmed by
> `tts-provider-specification.md` §32.2; it never carries a `delivery_mode` key.
> Delivery-mode and other performance-axis capability is declared at the provider/model level
> via `TTSProvider.capabilities()` (`tts-provider-specification.md` §3.3), not per-voice. The
> corrected example now uses three valid `emotion` members (`ANGRY`, `GRIEF`, `PLAYFUL`) against
> the three-level fidelity vocabulary (`NATIVE | APPROXIMATED | UNSUPPORTED`,
> `audio-script-ir.md` §39.2) and implies no unsupported semantics beyond that.

- **Mutation:** There is **no `PATCH` on a version**. `405`. This is deliberate: `context.md`
  §9.3 rule 1 — "never silently mutate", and any parameter change is a new version.
- **Status codes:** `201`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** `CONSENT_ATTESTATION_REQUIRED` (`422`), `VOICE_PROVIDER_UNKNOWN` (`422`),
  `VOICE_MODEL_UNAVAILABLE` (`409`) when no worker advertises that model
  (`context.md` §10.3).
- **Side effects:** Emits `voice.version_created`.

#### Upload reference audio

`POST /api/v1/voice-profiles/{voiceProfileId}/versions/{version}/reference-audio`

- **Purpose:** Attach reference audio to a version. Reference audio is an **artifact, not a
  parameter** (`context.md` §9.3.4): it lives in object storage, is content-hashed, and its
  hash participates in the version's identity.
- **Authorization:** Own tenant. **Idempotency-Key required.**
- **Request body:** the same declared-facts shape as an upload session (§16.6.5), restricted
  to the audio allowlist, with duration bounds and the consent attestation already recorded
  on the version.
- **Response:** `201` with an upload target set and a `reference_audio_upload_session`
  resource; the client uploads directly to object storage and finalizes at
  `POST .../reference-audio/completion`, which validates format, duration, and checksum.
- **State gate:** permitted **only** while the version is `DRAFT`. A version in
  `PREVIEW_GENERATED`, `APPROVED`, `LOCKED`, or `RETIRED` returns
  `409 VOICE_PROFILE_VERSION_IMMUTABLE` — swapping the audio file without a version bump
  would break `context.md` §30.7, which requires that reference audio participate in version
  identity by hash.
- **Status codes:** `201`, `400`, `401`, `404`, `409`, `413`, `422`.
- **Async behavior:** Embedding extraction runs asynchronously and is reported on the version
  as `speaker_reference.has_embedding`. The related job is `generate_voice_preview`'s
  prerequisite step; extraction itself is an internal job and is surfaced only through
  version state.

#### Generate a preview

`POST /api/v1/voice-profiles/{voiceProfileId}/versions/{version}/previews`

- **Purpose:** Render short samples so a human can judge the voice **before** the fleet spends
  GPU-hours (`context.md` §15.1: casting is a gate, not a suggestion).
- **Authorization:** Own tenant. **Idempotency-Key required.**
- **Request body:**

```json
{
  "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
  "character_id": "01J9Z4CR0000000000000002",
  "sample_selection": "CHARACTER_LINES",
  "sample_count": 3,
  "emotions": ["NEUTRAL", "ANGER", "GRIEF"],
  "priority": "INTERACTIVE"
}
```

| Field | Notes |
| --- | --- |
| `sample_selection` | `CHARACTER_LINES` — samples drawn from *that character's actual lines* (`context.md` §15.2 step 4) — or `FIXED_PHRASES` for a profile with no book context |
| `emotions` | Must be members of the closed emotion vocabulary; the response reports how each maps through `emotion_capability_map` |
| `priority` | Defaults to `INTERACTIVE`; previews must never starve behind a 20-hour render (`context.md` §11.4) |

- **Preconditions:** the version must have a usable speaker reference (embedding or reference
  audio) unless the provider supports reference-free synthesis; otherwise
  `409 VOICE_REFERENCE_MISSING`.
- **Response:** `202` with a job handle and the created preview placeholders:

```json
{
  "data": {
    "job": { "id": "01J9ZJOBPRV0000000000001", "object": "job", "type": "generate_voice_preview", "status": "QUEUED" },
    "accepted": { "scope": "VOICE_PREVIEW", "voice_profile_version": 4, "preview_ids": ["01J9ZPRV00000000000000A1"], "planned_unit_count": 3, "skipped_unit_count": 0 }
  }
}
```
  The preview rows exist immediately in status `GENERATING`; their audio does not.
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Side effects:** Version `approval_state` moves `DRAFT → PREVIEW_GENERATED` when the first
  preview succeeds. Emits `voice.preview_requested`, then `voice.preview_ready`.
- **Fidelity requirement (binding):** previews are generated with the **same provider, model
  version, and generation parameters as production** (`context.md` §15.3). The API therefore
  does not accept a `generation_params` override on a preview request — a preview that does
  not predict production output is worse than no preview.
- **Storage separation:** previews are stored separately from production audio and are **not
  part of any audiobook lineage** (`context.md` §15.3). No `Audiobook` ever references a
  preview key.
- **Related job:** `generate_voice_preview` (`gpu` queue, `INTERACTIVE` priority).

#### List and get previews

`GET /api/v1/voice-profiles/{id}/versions/{version}/previews`
`GET /api/v1/voice-profiles/{id}/versions/{version}/previews/{previewId}`

- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZPRV00000000000000A1",
    "object": "voice_preview",
    "voice_profile_id": "01J9ZVP0000000000000000A",
    "voice_profile_version": 4,
    "status": "READY",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "character_id": "01J9Z4CR0000000000000002",
    "source_paragraph_id": "01J9Z4PG0000000000001211",
    "text_excerpt": "\"You will not take the log,\" said Aurelio.",
    "emotion": "ANGER",
    "capability_gap": null,
    "duration_ms": 3200,
    "sample_rate": 24000,
    "tts_model_version_id": "01J9ZMV0000000000000TTS1",
    "generation_params_hash": "77aa...31",
    "seed": 4410221,
    "job_id": "01J9ZJOBPRV0000000000001",
    "error": null,
    "created_at": "...",
    "links": { "self": "...", "access_urls": ".../access-urls" }
  }
}
```

- **Preview status (§20.9):** `GENERATING | READY | FAILED | EXPIRED`. Preview audio is
  reached only through `.../access-urls` (§16.20); no key is returned.
- **Status codes:** `200`, `401`, `404`.

#### Approve a version

`POST /api/v1/voice-profiles/{id}/versions/{version}/approval`

- **Purpose:** Record the human casting decision (`context.md` §15.2 step 6).
- **Authorization:** Own tenant; `TENANT_MEMBER` or `TENANT_OWNER`.
- **Request body:** `{ "approved": true, "note": null }`. `approved: false` returns the
  version to `DRAFT` and is permitted only while it is `PREVIEW_GENERATED`.
- **Preconditions:** at least one `READY` preview exists, unless the tenant has explicitly
  enabled preview-free approval (`configuration`, default **off**) — otherwise
  `409 PREVIEW_REQUIRED_BEFORE_APPROVAL`.
- **Response:** `200` with the updated version (`approval_state: "APPROVED"`).
- **Status codes:** `200`, `401`, `403`, `404`, `409`, `422`.
- **Errors:** `PREVIEW_REQUIRED_BEFORE_APPROVAL`, `INVALID_STATE_TRANSITION`,
  `VOICE_PROFILE_LOCKED` (all `409`).
- **Idempotency:** Naturally idempotent — approving an approved version returns `200`
  unchanged.
- **Side effects:** Emits `voice.approved`. Sets the profile's `active_version` when this is
  the newest approved version.
- **Async behavior:** None; approval is a metadata decision.

#### Lock a version

`POST /api/v1/voice-profiles/{id}/versions/{version}/lock`

- **Purpose:** Freeze a version explicitly. Locking also happens **automatically** on first
  production render (`locked_reason: "USED_IN_GENERATION"`, `context.md` §15.2 step 7); this
  endpoint provides the `USER_LOCKED` path.
- **Request body:** `{ "reason": "USER_LOCKED" }`.
- **Response:** `200` with `lock_state: "LOCKED"`, `locked_at`, `locked_reason`.
- **Status codes:** `200`, `401`, `404`, `409`.
- **Binding consequence:** a `LOCKED` version is **immutable forever** (`context.md` §4.4,
  §9.3 rule 1). Every write to it — including reference audio, parameters, and language —
  is `409 VOICE_PROFILE_LOCKED` with a message pointing to version creation. There is no
  force flag, no admin override, and no unlock endpoint. Unlocking a version that produced
  retained audio would break the reproducibility contract of `context.md` §2.4.

#### Retire a version

`POST /api/v1/voice-profiles/{id}/versions/{version}/retirement`

- **Purpose:** Mark a version as no longer selectable for **new** assignments
  (`context.md` §9.2: `RETIRED` never means deleted).
- **Response:** `200` with `approval_state: "RETIRED"`.
- **Side effects:** Existing assignments and existing audio are untouched and remain valid
  and playable. Retiring the only approved version of a profile with active assignments is
  `409 VOICE_PROFILE_IN_USE`.

#### Voice preview and approval workflow (state machine)

```
create version (DRAFT)
      |
      v  POST .../previews            -> generate_voice_preview (INTERACTIVE)
PREVIEW_GENERATED  <---- preview READY
      |
      v  POST .../approval
APPROVED
      |
      v  first production render, or POST .../lock
LOCKED  (immutable forever)
      |
      v  POST .../retirement
RETIRED (not selectable for new assignments; existing audio unaffected)
```

**Version-state vocabulary decision.** `context.md` §9.2 and §4.4 fix the
`VoiceProfileVersion.approval_state` vocabulary as
`DRAFT | PREVIEW_GENERATED | APPROVED | LOCKED | RETIRED`. The commissioning brief listed
`DRAFT | GENERATING | READY | APPROVED | LOCKED | FAILED`. Those are two different things,
and this API keeps them separate rather than merging them:

- `approval_state` on the **version** uses the `context.md` vocabulary, unchanged.
- `status` on a **preview sample** uses `GENERATING | READY | FAILED | EXPIRED`, which is
  where "generating", "ready", and "failed" actually belong — they describe a render, not an
  approval.

Recorded as conflict C-5 in §23.

#### Book voice profiles

`GET /api/v1/books/{bookId}/voice-profiles`

- **Purpose:** The profiles relevant to one book: `scope: "BOOK"` profiles of that book, plus
  every tenant/system profile currently assigned to one of its characters.
- **Query parameters:** `assigned` (boolean), `approval_state`, §10 pagination.
- **Response:** `200` collection of voice profiles, each with an `assignments[]` block naming
  the `character_id`s in this book bound to it.

#### Read, set, and clear a character's voice

`GET|PUT|DELETE /api/v1/books/{bookId}/characters/{characterId}/voice`

- **Purpose:** The `(book, character) → voice_profile_version` assignment. **The Voice Service
  owns the assignment** (`context.md` §30.2); the Character Service never writes voice data,
  which is why the assignment is a `PUT` on a singleton sub-resource rather than a field of
  `PATCH /characters/{id}`.
- **Authorization:** Own tenant.
- **Request body (`PUT`):**

```json
{ "voice_profile_id": "01J9ZVP0000000000000000A", "voice_profile_version": 4 }
```
  `voice_profile_version` may be omitted to bind the profile's current approved version; the
  response always reports the **resolved concrete version**, because the IR records a
  concrete version and never a floating pointer (`context.md` §9.1).
- **Response:** `200`

```json
{
  "data": {
    "object": "voice_assignment",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "character_id": "01J9Z4CR0000000000000002",
    "voice_profile_id": "01J9ZVP0000000000000000A",
    "voice_profile_version": 4,
    "approval_state": "APPROVED",
    "snapshotted_from_system_profile_id": null,
    "assigned_at": "2026-08-27T13:10:00.000Z",
    "impact": {
      "chunks_bound_to_previous_version": 268,
      "chapters_affected": ["01J9Z4CH0000000000000012"],
      "requires_regeneration": true,
      "estimated_regeneration_units": 268
    }
  }
}
```

- **Status codes:** `200`, `204` (`DELETE`), `401`, `404`, `409`, `422`.
- **Errors:** `VOICE_PROFILE_NOT_APPROVED` (`409`), `VOICE_LANGUAGE_MISMATCH` (`409`) when
  the version does not support the book's language, `CHARACTER_NOT_FOUND` (`404`),
  `SENTINEL_CHARACTER_IMMUTABLE` (`409`) for `UNKNOWN_SPEAKER` and `SYSTEM`
  (the `NARRATOR` sentinel **is** assignable — a book needs a narrator voice).
- **Changing a voice after generation (binding, `context.md` §15.4):** the assignment change
  itself **never** mutates existing artifacts and **never** enqueues work. It returns the
  `impact` set. The user then calls `POST .../tts` with the scope they accept, and the API
  warns them: a partial re-voice produces an inconsistent audiobook, so a scope narrower than
  the impact set requires `"acknowledge_partial_revoice": true` (§16.15).
- **`DELETE`** clears the assignment; `409 VOICE_ASSIGNMENT_IN_USE` if chunks bound to it are
  `LOCKED` and no replacement is given.

#### Casting readiness

`GET /api/v1/books/{bookId}/casting`

- **Purpose:** The generation gate in one read: which speaking characters still lack an
  approved assignment (`context.md` §15.3).
- **Response:** `200`

```json
{
  "data": {
    "object": "casting_state",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "ready_for_generation": false,
    "narrator_fallback_accepted": false,
    "speaking_character_count": 23,
    "assigned_count": 21,
    "approved_count": 20,
    "blocking": [
      { "character_id": "01J9Z4CR0000000000000009", "display_name": "The Ferryman", "line_count": 14, "reason": "NO_ASSIGNMENT", "chapter_ids": ["01J9Z4CH0000000000000021"] },
      { "character_id": "01J9Z4CR0000000000000014", "display_name": "Marta", "line_count": 61, "reason": "ASSIGNMENT_NOT_APPROVED", "chapter_ids": ["01J9Z4CH0000000000000030"] }
    ],
    "per_chapter_readiness": [ { "chapter_id": "01J9Z4CH0000000000000012", "ready": true } ]
  }
}
```

- **Status codes:** `200`, `401`, `404`.

`POST /api/v1/books/{bookId}/casting/narrator-fallback`

- **Purpose:** Record the explicit user decision to let unassigned minor speakers use the
  narrator voice (`context.md` §15.3, §9.3 rule 2). Without this decision, generation is
  blocked.
- **Request body:** `{ "accepted": true, "applies_to": "MINOR_SPEAKERS_ONLY", "max_line_count": 20 }`.
- **Response:** `200` with the updated casting state.
- **Side effects:** Recorded as an **explicit decision on the book**, with principal and
  timestamp, and audited. It is not a silent default and cannot be inferred.
- **Status codes:** `200`, `401`, `404`, `409`, `422`.
---

### 16.15 TTS generation and audio chunks

The GPU worker is never exposed (`context.md` §10.1, §24.3). This is an **orchestration
endpoint**: it validates prerequisites, creates jobs, enqueues, and returns job information.
It synthesizes nothing.

#### Start TTS generation

`POST /api/v1/books/{bookId}/tts`

- **Purpose:** Enqueue synthesis for a scope. **It must not synchronously generate anything —
  not a chapter, not a chunk** (`context.md` §2.3 hard rule).
- **Authentication:** Required. **Authorization:** Own tenant.
- **Request headers:** `Idempotency-Key` **required**.
- **Path parameters:** `bookId`.
- **Query parameters:** —
- **Request body:**

```json
{
  "scope": "CHUNKS",
  "chapter_ids": null,
  "chunk_ids": ["01J9ZASC000000000000A001"],
  "filter": null,
  "force": false,
  "acknowledge_partial_revoice": false,
  "priority": "INTERACTIVE"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `scope` | Yes | `BOOK` \| `CHAPTERS` \| `CHUNKS` \| `FILTER` |
| `chapter_ids` / `chunk_ids` | Conditional | Required for their scope; bounded array length |
| `filter` | Conditional | For `scope: "FILTER"`: `{ "audio_chunk_status": ["FAILED","INVALID"], "chapter_ids": [...] }`. This is how a client retries every failed chunk without enumerating ids |
| `force` | No | §11.5. Regenerates even where valid output exists for the current lineage; always produces **new** chunk versions |
| `acknowledge_partial_revoice` | Conditional | Required when the scope is narrower than the impact set of a voice change (`context.md` §15.4 step 5) |
| `priority` | No | `INTERACTIVE` \| `NORMAL` \| `BULK`. `INTERACTIVE` is accepted only for `CHUNKS` scope below a bounded size (`configuration`); otherwise `422` |

- **Prerequisite validation, all before acceptance:**

| # | Check | Failure |
| --- | --- | --- |
| 1 | Book not deleted; ingestion complete | `409 INGESTION_NOT_COMPLETE` |
| 2 | A current `AudioScript` exists covering the scope and is `VALIDATED` (`context.md` §14.2) | `409 AUDIO_SCRIPT_NOT_VALIDATED` |
| 3 | IR coverage invariant verified for the scope's chapters | `409 AUDIO_SCRIPT_COVERAGE_INVALID` |
| 4 | **Every speaking character in the scope has an `APPROVED` voice assignment**, or narrator-fallback was explicitly accepted (`context.md` §9.3 rule 2, §15.3) | `409 CASTING_INCOMPLETE`, with the blocking characters in `details` |
| 5 | Every bound `VoiceProfileVersion` targets a provider/model that some worker advertises (`context.md` §10.3) | `409 VOICE_MODEL_UNAVAILABLE` |
| 6 | No Director version mixing within the scope | `409 DIRECTOR_VERSION_MIXING_FORBIDDEN` |
| 7 | Tenant quota and concurrency | `429 QUOTA_EXCEEDED` / `CONCURRENCY_LIMIT_REACHED` |

- **Response:** `202` (§7.3), `Location` = the coordinator job.

```json
{
  "data": {
    "job": { "id": "01J9ZJOBTTS0000000000001", "object": "job", "type": "generate_tts_chunk", "status": "QUEUED", "book_id": "01J9Z2K...", "links": { "self": "/api/v1/jobs/01J9ZJOBTTS0000000000001" } },
    "accepted": {
      "scope": "CHUNKS",
      "chunk_ids": ["01J9ZASC000000000000A001"],
      "planned_unit_count": 1,
      "skipped_unit_count": 0,
      "skip_reason": null,
      "queue_position": 12,
      "priority": "INTERACTIVE"
    }
  }
}
```

  `queue_position` is the user-visible admission-control signal of `context.md` §20.5. It is
  advisory and may be `null` under load; it is never an ETA.
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Errors:** as the prerequisite table, plus `MISSING_IDEMPOTENCY_KEY` (`400`) and
  `VALIDATION_FAILED` (`422`).
- **Idempotency:** Required at HTTP level; job level uses
  `tts:{audio_script_chunk_id}:{voice_profile_version}:{tts_model_version}:{params_hash}`
  (`context.md` §16.3), so a re-delivery with an existing successful result performs no work.
- **Side effects:**
  - Book state → `GENERATING`.
  - Each targeted `AudioScriptChunk` **freezes** when its `TTSJob` enters `RUNNING`
    (`context.md` §7.3): `state` becomes `LOCKED` and its performance fields become
    immutable. This is why §16.13's `PATCH` starts failing mid-render, and the contract says
    so rather than surprising the client.
  - Each bound `VoiceProfileVersion` becomes `LOCKED` with
    `locked_reason: "USED_IN_GENERATION"` (`context.md` §15.2 step 7).
  - Emits `tts.started`, then `tts.chunk_completed` / `tts.chunk_failed` per chunk, then
    `tts.completed`.
- **Async behavior:** Always, and **chunk-granular**. The coordinator job fans out one
  `generate_tts_chunk` job per chunk (`context.md` §16.4). No request ever renders a chapter
  synchronously.
- **Related jobs:** `generate_tts_chunk` (`gpu` queue), then `validate_audio` and
  `process_audio` (`audio` queue) per chunk.

**Chunk regeneration is this endpoint with `scope: "CHUNKS"`.** There is no separate
regeneration endpoint, and regenerating one chunk never requires regenerating its chapter
(`context.md` §16.4). Regeneration always produces a **new `AudioChunk` version** with a
`supersedes` pointer; the previous chunk is retained and marked `SUPERSEDED`
(`context.md` §2.5).

#### Get TTS generation state

`GET /api/v1/books/{bookId}/tts`

- **Response:** `200`

```json
{
  "data": {
    "object": "tts_state",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "status": "RUNNING",
    "counts": {
      "chunks_total": 8420,
      "chunks_pending": 3120,
      "chunks_generating": 48,
      "chunks_generated": 5200,
      "chunks_validated": 5180,
      "chunks_failed": 14,
      "chunks_invalid": 6,
      "chunks_superseded": 41
    },
    "progress": 0.61,
    "provider_mix": [ { "tts_provider_id": "xtts-v2", "tts_model_version_id": "01J9ZMV0000000000000TTS1", "chunk_count": 8420 } ],
    "capability_gap_count": 23,
    "current_job_id": "01J9ZJOBTTS0000000000001",
    "history": [],
    "links": { "job": "/api/v1/jobs/01J9ZJOBTTS0000000000001", "failed_chunks": "/api/v1/books/01J9Z2K.../audio-chunks?status=FAILED" }
  }
}
```

- `progress` is computed from **completed units**, never from wall clock
  (`context.md` §11.4). There is no ETA field here; ETA with explicit confidence lives on the
  progress endpoint (§16.19).
- **Status codes:** `200`, `401`, `404`.

#### List audio chunks

`GET /api/v1/books/{bookId}/audio-chunks`

- **Purpose:** Inspect rendered audio at chunk granularity: status, lineage, and failure
  information.
- **Query parameters:** `audio_script_chunk_id`, `chapter_id`, `scene_id`, `character_id`,
  `status` (multi), `voice_profile_id`, `voice_profile_version`, `tts_model_version_id`,
  `has_capability_gap`, `include_superseded` (default `false`), `sort` (allowlist
  `sequence_index`, `created_at`; default `sequence_index:asc`), §10 pagination.
- **Response:** `200` collection of the resource below.

#### Get an audio chunk

`GET /api/v1/books/{bookId}/audio-chunks/{audioChunkId}`

- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZAC000000000000A0011",
    "object": "audio_chunk",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "audio_script_chunk_id": "01J9ZASC000000000000A001",
    "chapter_id": "01J9Z4CH0000000000000012",
    "scene_id": "01J9Z4SC0000000000000031",
    "sequence_index": 4021,
    "generation_version": 2,
    "supersedes_audio_chunk_id": "01J9ZAC000000000000A0010",
    "is_current": true,
    "status": "VALIDATED",
    "lineage": {
      "source_content_hash": "3c81...aa",
      "audio_script_ir_schema_version": "ir.v1.2",
      "director_version": "director.v3",
      "director_model_version_id": "01J9ZMV0000000000000LLM1",
      "voice_profile_id": "01J9ZVP0000000000000000A",
      "voice_profile_version": 4,
      "tts_provider_id": "xtts-v2",
      "tts_model_version_id": "01J9ZMV0000000000000TTS1",
      "generation_params_hash": "77aa...31",
      "seed": 8123471,
      "pipeline_version": "pipeline.v1"
    },
    "technical": {
      "duration_ms": 3120,
      "sample_rate": 24000,
      "channels": 1,
      "peak_dbfs": -3.4,
      "integrated_lufs": -19.1,
      "format": "WAV"
    },
    "validation": {
      "status": "PASS",
      "checks": [ { "check": "duration_within_expected_band", "outcome": "PASS" }, { "check": "true_peak_clipping", "outcome": "PASS" } ],
      "asr": { "sampled": true, "wer": 0.021, "threshold": 0.08, "outcome": "PASS" }
    },
    "capability_gaps": [ { "field": "delivery_mode", "requested": "WHISPER", "handling": "APPROXIMATED", "note": "volume+pacing approximation" } ],
    "error": null,
    "job_id": "01J9ZJOBTTS0000000000042",
    "attempt_count": 1,
    "created_at": "...", "updated_at": "...",
    "links": { "self": "...", "script_chunk": "...", "job": "/api/v1/jobs/01J9ZJOBTTS0000000000042", "access_urls": ".../access-urls" }
  }
}
```

  On failure, `error` carries the typed error class, the failing check, and the attempt
  count:

```json
{ "error": { "code": "AUDIO_VALIDATION_FAILED", "class": "AUDIO_QC", "failing_check": "duration_within_expected_band", "message": "Rendered duration was 4.1x the expected band, indicating runaway repetition.", "attempts": 3, "terminal": false } }
```

- **Audio URL:** never a key, never a permanent URL. Byte access is `POST .../access-urls`
  (§16.20), permitted only for chunks in `GENERATED`, `VALIDATED`, or `INVALID` status — an
  `INVALID` chunk is deliberately audible so a human can judge it (`context.md` §14.5).
- **Mutation:** none. `PATCH`/`DELETE` are `405` — `AudioChunk` is immutable
  (`context.md` §4.5).
- **Status codes:** `200`, `304`, `401`, `404`.

---

### 16.16 Assembly and chapter audio

#### Start assembly

`POST /api/v1/books/{bookId}/assembly`

- **Purpose:** Assemble validated chunks into `ChapterAudio`, and chapters into an
  `Audiobook` (`context.md` §3.2.14). Assembly is a **pure function of its inputs** and is
  always safe to re-run.
- **Authorization:** Own tenant. **Idempotency-Key required.**
- **Request body:**

```json
{
  "scope": "AUDIOBOOK",
  "chapter_ids": null,
  "delivery_formats": ["M4B"],
  "allow_partial_preview": false,
  "force": false,
  "priority": "NORMAL"
}
```

| Field | Notes |
| --- | --- |
| `scope` | `CHAPTERS` (assemble the named chapters) \| `AUDIOBOOK` (assemble every chapter, then the book) |
| `delivery_formats` | Subset of `["M4B", "M4A", "MP3_PER_CHAPTER"]` (`context.md` §13.2). Exactly **one lossy encode**, at this final step |
| `allow_partial_preview` | When `true`, assembly may run on an incomplete chunk set and produces an artifact explicitly marked `is_preview_build: true`, which is **never** published as final (`context.md` §21 row 16) |
| `force` | §11.5 |

- **Prerequisite validation:**

| # | Check | Failure |
| --- | --- | --- |
| 1 | Every chunk in the manifest exists, is `current`, and is `VALIDATED` | `409 CHAPTER_MANIFEST_INCOMPLETE` with the missing count and the first missing ids in `details`, unless `allow_partial_preview: true` |
| 2 | **Voice consistency:** all chunks sharing a `character_id` share a `voice_profile_version`, across the chapter and across the book (`context.md` §9.1) | `409 VOICE_CONSISTENCY_VIOLATION` naming the character and the conflicting versions |
| 3 | Single Director version across the scope | `409 DIRECTOR_VERSION_MIXING_FORBIDDEN` |
| 4 | Book metadata sufficient for the container (title, author, language) | `422 VALIDATION_FAILED` |

  Check 2 is the architectural test of `context.md` §9.1: consistency is **validated, not
  assumed**, and the API refuses to assemble rather than shipping an inconsistent audiobook.
- **Response:** `202` (§7.3) with `accepted.scope`, `accepted.chapter_ids`,
  `accepted.planned_unit_count`, and `accepted.delivery_formats`.
- **Status codes:** `202`, `400`, `401`, `404`, `409`, `422`, `429`.
- **Idempotency:** Required. Job key:
  `assemble_chapter:{chapter_id}:{ordered_chunk_manifest_hash}` (`context.md` §16.3), so
  re-running assembly on an unchanged manifest returns the existing result and does no work.
- **Side effects:** Book state → `ASSEMBLING`, then `COMPLETED`. Emits
  `chapter.assembly_started`, `chapter.completed`, `audiobook.assembly_started`,
  `audiobook.completed` or `audiobook.failed`.
- **Async behavior:** Always. `assemble_chapter` and `assemble_audiobook` run on the `audio`
  queue; `encode_delivery_format` follows.
- **Related jobs:** `assemble_chapter`, `assemble_audiobook`, `encode_delivery_format`.

#### Get assembly state

`GET /api/v1/books/{bookId}/assembly`

- **Response:** `200` with
  `{ status, scope, chapters_assembled, chapters_total, audiobook_id, delivery_formats[],
  voice_consistency: { verified: true, checked_characters: 23 }, blocking[], current_job_id,
  history[], links }`.
- **Status codes:** `200`, `401`, `404`.

#### List and get chapter audio

`GET /api/v1/books/{bookId}/chapter-audio`
`GET /api/v1/books/{bookId}/chapter-audio/{chapterAudioId}`

- **Purpose:** The assembled per-chapter track — a **distinct concept** from `Chapter` and
  from `Audiobook` (§16.17).
- **Query parameters:** `chapter_id`, `include_superseded` (default `false`), `status`, §10
  pagination, default order `version:desc`.
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZCA00000000000000012",
    "object": "chapter_audio",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "chapter_id": "01J9Z4CH0000000000000012",
    "version": 3,
    "supersedes_chapter_audio_id": "01J9ZCA00000000000000011",
    "is_current": true,
    "is_preview_build": false,
    "status": "ASSEMBLED",
    "duration_ms": 1842000,
    "chunk_count": 268,
    "chunk_manifest_hash": "1b9d...c4",
    "loudness": { "integrated_lufs": -19.0, "true_peak_dbtp": -3.1 },
    "format": "WAV",
    "lineage": {
      "director_version": "director.v3",
      "pipeline_version": "pipeline.v1",
      "voice_profile_versions": [ { "character_id": "01J9Z4CR0000000000000002", "voice_profile_id": "01J9ZVP0000000000000000A", "voice_profile_version": 4 } ],
      "ffmpeg_model_version_id": "01J9ZMV0000000000000FFMP"
    },
    "created_at": "...",
    "links": { "self": "...", "chapter": "...", "access_urls": ".../access-urls" }
  }
}
```

- **Mutation:** none — `ChapterAudio` is immutable (`context.md` §4.5). `PATCH`/`DELETE` are
  `405`.
- **Status codes:** `200`, `401`, `404`, `422`.

---

### 16.17 Audiobook

`context.md` requires five concepts to remain distinct, and this API keeps them on separate
resources:

| Concept | Resource | Meaning |
| --- | --- | --- |
| **book** | `/books/{bookId}` | The work and its pipeline state |
| **chapter** | `/books/{bookId}/chapters/{chapterId}` | A structural division of the reading spine |
| **chapter audio** | `/books/{bookId}/chapter-audio/{id}` | An assembled, versioned audio track for one chapter |
| **audiobook project** | `/books/{bookId}/audiobook` | The current pointer plus generation state for the book's audiobook |
| **final audiobook artifact** | `/books/{bookId}/audiobooks/{audiobookId}` | One immutable, versioned, encoded deliverable |

They are never collapsed. In particular, `GET /books/{bookId}/audiobook` (singular) is the
**project view** and `GET /books/{bookId}/audiobooks/{id}` is an **artifact**.

#### Get the audiobook project view

`GET /api/v1/books/{bookId}/audiobook`

- **Purpose:** One read that answers "where is my audiobook?" — generation status, the
  current artifact, and per-chapter readiness.
- **Response:** `200`

```json
{
  "data": {
    "object": "audiobook_project",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "generation_status": "COMPLETED",
    "current_audiobook_id": "01J9ZAB00000000000000002",
    "current_version": 2,
    "version_count": 2,
    "chapters": [
      { "chapter_id": "01J9Z4CH0000000000000012", "order_index": 12, "title": "The Keeper's Log", "chapter_audio_id": "01J9ZCA00000000000000012", "status": "ASSEMBLED", "duration_ms": 1842000 }
    ],
    "totals": { "chapters": 40, "chapters_assembled": 40, "duration_ms": 43200000 },
    "blocking": [],
    "links": { "self": "...", "versions": "/api/v1/books/01J9Z2K.../audiobooks", "current": "/api/v1/books/01J9Z2K.../audiobooks/01J9ZAB00000000000000002" }
  }
}
```

- `generation_status` (§20.10): `NOT_STARTED | BLOCKED | ASSEMBLING | COMPLETED | FAILED |
  STALE`. `STALE` means a newer chapter audio version exists that the current audiobook does
  not include — stated explicitly rather than silently serving an outdated artifact.
- **Status codes:** `200`, `401`, `404`.

#### List and get audiobook artifacts

`GET /api/v1/books/{bookId}/audiobooks`
`GET /api/v1/books/{bookId}/audiobooks/{audiobookId}`

- **Query parameters (list):** `include_superseded` (default `false`), `format`, §10
  pagination, default order `version:desc`.
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZAB00000000000000002",
    "object": "audiobook",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "version": 2,
    "supersedes_audiobook_id": "01J9ZAB00000000000000001",
    "is_current": true,
    "is_preview_build": false,
    "status": "READY",
    "container_format": "M4B",
    "available_formats": ["M4B", "MP3_PER_CHAPTER"],
    "duration_ms": 43200000,
    "size_bytes": 612344320,
    "chapter_manifest": [
      { "chapter_id": "01J9Z4CH0000000000000001", "chapter_audio_id": "01J9ZCA00000000000000001", "order_index": 1, "title": "The Sailing", "start_ms": 0, "duration_ms": 1042000 }
    ],
    "metadata": {
      "title": "The Lighthouse at the End of the World",
      "author": "Jules Verne",
      "narrator_credit": "AI-narrated",
      "ai_narration_disclosed": true,
      "series": null,
      "publisher": null,
      "language": "en-GB",
      "publication_year": 1905,
      "description": null
    },
    "cover": { "present": true, "width": 3000, "height": 3000, "content_hash": "ab12...ff" },
    "quality": { "book_wer": 0.019, "chunks_flagged": 37, "asr_coverage": 0.12 },
    "lineage": {
      "pipeline_version": "pipeline.v1",
      "director_version": "director.v3",
      "tts_model_version_ids": ["01J9ZMV0000000000000TTS1"],
      "ffmpeg_model_version_id": "01J9ZMV0000000000000FFMP",
      "source_content_hash": "9f2c...e1"
    },
    "created_at": "...",
    "links": { "self": "...", "access_urls": ".../access-urls", "cover": ".../cover" }
  }
}
```

  `ai_narration_disclosed` is always `true` and is not client-settable: AI narration
  disclosure is **mandatory** in output metadata (`context.md` §13.4).
- **Mutation:** `PATCH` accepts only presentational metadata that has not yet been embedded
  (`description`, `series`, `publisher`) and only while `status` is `DRAFT_METADATA`. Once
  `READY`, the artifact is immutable and `PATCH` is `409 AUDIOBOOK_IMMUTABLE`: changing
  metadata means assembling a new version. `narrator_credit` and `ai_narration_disclosed` are
  never patchable (`422` / `immutable`).
- **Status codes:** `200`, `304`, `401`, `404`, `409`, `422`.

#### Set the cover image

`PUT /api/v1/books/{bookId}/audiobooks/{audiobookId}/cover`

- **Purpose:** Attach cover art for embedding at encode time.
- **Request body:** the declared-facts shape of §16.6.5 restricted to the image allowlist; the
  response is an upload target and the client uploads directly to object storage. **No URL is
  ever accepted** (§14.7 SSRF).
- **State gate:** permitted only while the audiobook is `DRAFT_METADATA`; `409
  AUDIOBOOK_IMMUTABLE` once `READY`.
- **Side effects:** EXIF stripped; dimensions and size validated; content-hashed.
- **Status codes:** `200`/`201`, `401`, `404`, `409`, `413`, `422`.

---

### 16.18 Jobs

One job vocabulary, matching `context.md` §16.1 exactly. The API invents no states
(`context.md` §25.8, §25.9).

#### List jobs

`GET /api/v1/jobs`

- **Purpose:** Every job the caller's tenant owns, filterable to a book or a resource.
- **Authentication:** Required. **Authorization:** `context.md` §18.2 — a user may read only
  jobs whose target resources they own. The job's recorded `tenant_id` is the check.
- **Query parameters:** `book_id`, `type` (multi, from §20.3), `status` (multi, from §20.2),
  `related_resource_id`, `created_after`, `created_before`, `sort` (allowlist `created_at`,
  `completed_at`; default `created_at:desc`), §10 pagination.
- **Response:** `200` collection of job resources.
- **Status codes:** `200`, `401`, `422`.

#### Get a job

`GET /api/v1/jobs/{jobId}`

- **Purpose:** The authoritative state of one job, read from persisted job state — never from
  a worker or from queue memory (`context.md` §3.2.11).
- **Response:** `200`

```json
{
  "data": {
    "id": "01J9ZJOBTTS0000000000042",
    "object": "job",
    "type": "generate_tts_chunk",
    "status": "RETRYING",
    "tenant_id": "01J9Z0TEN00000000000000001",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "related_resource": { "type": "audio_script_chunk", "id": "01J9ZASC000000000000A001" },
    "parent_job_id": "01J9ZJOBTTS0000000000001",
    "child_job_count": 0,
    "priority": "NORMAL",
    "queue": "gpu",
    "progress": { "value": 0.0, "stage": "AWAITING_RETRY", "completed_units": 0, "total_units": 1 },
    "attempt_count": 2,
    "max_attempts": 3,
    "retry_count": 2,
    "next_attempt_at": "2026-08-27T15:04:11.000Z",
    "cancellation": { "requested": false, "requested_at": null, "requested_by": null, "effective": false },
    "error": {
      "code": "TTS_ENGINE_ERROR",
      "class": "TTS",
      "message": "The synthesis engine returned an unusable result. A further attempt is scheduled.",
      "retryable": true,
      "terminal": false,
      "attempt_number": 2
    },
    "result": null,
    "idempotency_fingerprint": "b0d1...7e",
    "forced": false,
    "created_at": "2026-08-27T14:58:00.000Z",
    "queued_at": "2026-08-27T14:58:01.000Z",
    "started_at": "2026-08-27T15:00:20.000Z",
    "completed_at": null,
    "updated_at": "2026-08-27T15:03:11.000Z",
    "links": { "self": "...", "attempts": ".../attempts", "cancellation": ".../cancellation", "events": ".../events", "book": "/api/v1/books/01J9Z2K7Q0V6Y8B3M4N5P6R7S8" }
  }
}
```

  On success, `result` names the produced artifact:
  `{ "type": "audio_chunk", "id": "01J9ZAC000000000000A0011", "version": 2 }`.
  `result` is `null` in every non-terminal state — the API never predicts an outcome.
- **Job fields (contractual):** `id`, `type`, `status`, `progress`, `created_at`,
  `queued_at`, `started_at`, `completed_at`, `error`, `retry_count`, `attempt_count`,
  `related_resource`, `cancellation` — the full set the architecture requires.
- **Status codes:** `200`, `401`, `404`.

#### List job attempts

`GET /api/v1/jobs/{jobId}/attempts`

- **Purpose:** The audit trail for "why does this chunk sound different?" (`context.md` §16.2).
- **Response:** `200` collection of
  `{ id, object: "job_attempt", attempt_number, status, worker_id, started_at, ended_at,
  duration_ms, model_versions: [{ role, model_version_id }], error: { code, class, message },
  resource_usage: { vram_peak_mb, duration_ms }, output_artifact: { type, id } }`.
  `ProcessingAttempt` is immutable (`context.md` §4.5); there is no mutation endpoint.
- **Worker identity:** `worker_id` is an opaque internal identifier. Hostnames, IPs, GPU
  serial numbers, and queue names beyond the logical queue label are **not** returned to
  public clients (§14.11, §8.2).
- **Status codes:** `200`, `401`, `404`.

#### Cancel a job

`POST /api/v1/jobs/{jobId}/cancellation`

- **Purpose:** Request cooperative cancellation (`context.md` §11.4).
- **Path shape note:** `cancellation` is a noun sub-resource, per `context.md` §25.1's rule
  that non-CRUD actions are modelled as sub-resource commands. The commissioning brief's
  `/cancel` is the same operation under a verb path; the noun form is the contract
  (conflict C-6, §23).
- **Authentication:** Required. **Authorization:** `context.md` §18.2 — only jobs whose target
  resources the caller owns. `PLATFORM_ADMIN` may cancel any job (audited, §16.22).
- **Request body:** `{ "reason": "User cancelled from the studio view." }` — optional, 0–512
  chars.
- **Response:** `200` with the job resource reflecting the cancellation request.
- **Behavior by current state (binding, and idempotent in every case):**

| Current status | Result | HTTP |
| --- | --- | --- |
| `CREATED` | Transitions to `CANCELLED` immediately | `200` |
| `QUEUED` | Removed from the queue, transitions to `CANCELLED` | `200` |
| `BLOCKED` | Transitions to `CANCELLED` | `200` |
| `RETRYING` | Scheduled retry dropped, transitions to `CANCELLED` | `200` |
| `RUNNING` | `cancellation.requested = true`; the worker observes the flag at the next chunk boundary and exits cleanly. Status stays `RUNNING` until it does; then `CANCELLED`. **The response does not claim the work stopped** — `cancellation.effective` is `false` until the worker acknowledges | `200` |
| `SUCCEEDED` | No-op. `cancellation.requested` stays `false`; the job remains `SUCCEEDED` | `200` |
| `FAILED` | No-op; remains `FAILED` | `200` |
| `CANCELLED` | No-op; remains `CANCELLED`, original `requested_at` preserved | `200` |
| `DEAD_LETTERED` | No-op; remains `DEAD_LETTERED` | `200` |

  Cancellation is **safe and idempotent**: repeated calls never change the outcome, never
  produce an error for a terminal job, and never revive a job. A `409` is **not** used for a
  terminal job — cancelling something already finished is a no-op, not a conflict.
- **Status codes:** `200`, `401`, `404`, `422`.
- **Side effects:** Sets the Redis cancellation flag; emits `job.cancelled` when effective.
  **Completed work is retained** (`context.md` §11.4): a cancelled book keeps its finished,
  validated chunks and can resume. Partial artifacts of the cancelled attempt are released as
  `CANCELLED` and are never marked valid.
- **Cascade:** Cancelling a coordinator job cancels its `CREATED`/`QUEUED`/`BLOCKED` children
  and requests cancellation of `RUNNING` children. Cancelling a child does not cancel its
  parent.
- **Async behavior:** The request itself is synchronous and returns immediately
  (`context.md` §2.3 permits this); the *effect* on a `RUNNING` job is asynchronous, and the
  contract says so.

#### Retry and replay

There is **no public retry endpoint.** Retries are the job system's own concern
(`context.md` §11.4: per-job-type max attempts with backoff), and a user-visible "retry"
is a scoped stage command (§13.4) that creates fresh jobs with full lineage. Operator
**replay of a dead-lettered job** is administrative and lives at
`POST /api/v1/admin/jobs/{jobId}/replay` (§16.22), because `context.md` §11.4 describes DLQ
replay as an operator action after the cause is fixed.

---

### 16.19 Progress and event streams

#### Book progress

`GET /api/v1/books/{bookId}/progress`

- **Purpose:** The aggregate the frontend polls. Computed from **persisted job state**, never
  from in-memory worker state (`context.md` §3.2.11, §11.4).
- **Authorization:** Own tenant.
- **Response:** `200`

```json
{
  "data": {
    "object": "book_progress",
    "book_id": "01J9Z2K7Q0V6Y8B3M4N5P6R7S8",
    "book_status": "GENERATING",
    "overall_progress": 0.58,
    "degraded": false,
    "stages": [
      { "stage": "ingestion", "status": "SUCCEEDED", "progress": 1.0, "completed_units": 412, "total_units": 412, "failed_units": 3, "flagged_units": 3 },
      { "stage": "analysis",  "status": "SUCCEEDED", "progress": 1.0, "completed_units": 40, "total_units": 40, "failed_units": 0, "flagged_units": 2 },
      { "stage": "director",  "status": "SUCCEEDED", "progress": 1.0, "completed_units": 8420, "total_units": 8420, "failed_units": 0, "flagged_units": 37 },
      { "stage": "tts",       "status": "RUNNING",   "progress": 0.61, "completed_units": 5180, "total_units": 8420, "failed_units": 14, "flagged_units": 6 },
      { "stage": "assembly",  "status": "NOT_STARTED", "progress": 0.0, "completed_units": 0, "total_units": 41, "failed_units": 0, "flagged_units": 0 }
    ],
    "active_job_ids": ["01J9ZJOBTTS0000000000001"],
    "needs_review_count": 43,
    "estimate": {
      "remaining_ms": 9420000,
      "confidence": "LOW",
      "basis": "COMPLETED_UNIT_RATE",
      "computed_at": "2026-08-27T15:04:00.000Z"
    },
    "queue": { "position": 12, "backpressure": false },
    "updated_at": "2026-08-27T15:04:00.000Z"
  }
}
```

- **Binding rules:** `progress` is derived from completed units. `estimate` carries an
  explicit `confidence` (`HIGH | MEDIUM | LOW | NONE`) and a `basis`, and `remaining_ms` is
  `null` whenever `confidence` is `NONE`. **A fabricated ETA is a contract violation**
  (`context.md` §25.8).
- **Polling:** clients **SHOULD** poll no faster than the interval advertised in the
  `RateLimit-*` headers for the `read` bucket; the `stream` path (below) exists so that a
  fast UI does not need a fast poll.
- **Status codes:** `200`, `401`, `404`.

#### Book event stream · Job event stream

`GET /api/v1/books/{bookId}/events` · `GET /api/v1/jobs/{jobId}/events`

- **Purpose:** Live observation of persisted state changes. **HTTP polling is the baseline
  and is always sufficient**; SSE is the low-latency path.
- **Decision — SSE, not WebSockets.** `context.md` §25.8: "a streaming channel (SSE preferred
  over WebSockets for one-way progress)". Progress is one-way, so SSE is the contract for
  `v1`. WebSockets remain architecturally available for a future bidirectional need
  (`context.md` §3.2.15 lists both) and would be an additive change under §27 — a new
  endpoint, never a change to this one.
- **Authentication:** Required. The credential travels in the `Authorization` header or the
  session cookie. **A token is never accepted as a query parameter**, because URLs are
  logged.
- **Authorization:** Own tenant; a cross-tenant `bookId` is `404` before the stream opens.
- **Protocol:**

```
GET /api/v1/books/{bookId}/events
Accept: text/event-stream
Last-Event-ID: 01J9ZEVT0000000000000042
```

```
: keep-alive

id: 01J9ZEVT0000000000000043
event: job.progress
data: {"schema_version":"events.v1","event_type":"job.progress","occurred_at":"2026-08-27T15:04:03.221Z","book_id":"01J9Z2K...","job_id":"01J9ZJOBTTS0000000000001","correlation_id":"...","payload":{"progress":0.61,"completed_units":5180,"total_units":8420}}

id: 01J9ZEVT0000000000000044
event: tts.chunk_completed
data: {"schema_version":"events.v1","event_type":"tts.chunk_completed","occurred_at":"...","book_id":"01J9Z2K...","payload":{"audio_script_chunk_id":"01J9ZASC...","audio_chunk_id":"01J9ZAC...","generation_version":2}}
```

- **Event names are exactly those in `context.md` §11.3.** The API invents none, and their
  payload schemas belong to `event-contracts.md`. Public streams carry the **book-scoped
  subset**: `book.*`, `character.*`, `voice.*`, `director.*`, `tts.*`, `audio.*`,
  `chapter.*`, `audiobook.*`, and `job.*` for jobs the caller owns.
- **Payload rule:** events carry identifiers and small facts, never bulk content
  (`context.md` §11.3). No text, no audio, no signed URL ever appears in an event.
- **Resumption:** `Last-Event-ID` replays from the buffered tail (bounded window,
  `configuration`). If the requested id is outside the window, the server sends a
  `stream.resync` control event instructing the client to re-read
  `GET .../progress` — the stream is a **notification channel, not a source of truth**.
- **Connection limits:** bounded concurrent streams per principal; exceeding is `429`.
  Idle connections receive a keep-alive comment; the server closes streams after a bounded
  lifetime and expects the client to reconnect.
- **Status codes:** `200` (stream opens), `401`, `404`, `429`.
- **Side effects:** none.

**Progress is never sourced from a worker.** Both the poll endpoint and the stream read the
Job Service's persisted state; a worker's in-memory belief is not observable through this
API (`context.md` §3.2.11 — the Job Service is the authority, and the queue is a cache of it).

---

### 16.20 Access URLs — download and streaming

One uniform sub-resource governs every byte in the system.

`POST /api/v1/books/{bookId}/audiobooks/{audiobookId}/access-urls`
`POST /api/v1/books/{bookId}/chapter-audio/{chapterAudioId}/access-urls`
`POST /api/v1/books/{bookId}/audio-chunks/{audioChunkId}/access-urls`
`POST /api/v1/books/{bookId}/files/{bookFileId}/access-urls`
`POST /api/v1/books/{bookId}/text/access-urls`
`POST /api/v1/voice-profiles/{id}/versions/{version}/previews/{previewId}/access-urls`

- **Purpose:** Mint a short-lived, single-object, single-method signed URL. **This is the only
  way any client obtains bytes**, and no permanent or private object-storage URL is ever
  returned (`context.md` §12.3, §18.7).
- **Authentication:** Required — always. A signed URL is minted **only after** an ownership
  check (`context.md` §18.2).
- **Authorization:** Own tenant, and the artifact must be in a state whose bytes exist.
  `PLATFORM_ADMIN` is explicitly **refused** here: `403 ADMIN_CONTENT_ACCESS_DENIED` (§6.6).
- **Request body:**

```json
{
  "disposition": "INLINE",
  "format": "M4B",
  "expires_in_seconds": 300
}
```

| Field | Notes |
| --- | --- |
| `disposition` | `INLINE` (streaming/playback) or `ATTACHMENT` (download). Controls `Content-Disposition` on the signed response |
| `format` | Required where the artifact has multiple delivery formats; must be one the artifact actually has, else `409 FORMAT_NOT_AVAILABLE` |
| `expires_in_seconds` | Optional, bounded to a maximum of a few minutes (`configuration`). A request above the maximum is `422` / `out_of_range`, never silently clamped |

- **Response:** `200`

```json
{
  "data": {
    "object": "access_url",
    "url": "https://storage.example.com/...&X-Amz-Expires=300&X-Amz-Signature=...",
    "method": "GET",
    "expires_at": "2026-08-27T15:09:03.221Z",
    "disposition": "INLINE",
    "format": "M4B",
    "supports_range": true,
    "content_type": "audio/mp4",
    "size_bytes": 612344320,
    "duration_ms": 43200000,
    "content_hash": { "algorithm": "sha256", "value": "ab12...ff" }
  }
}
```

- **Status codes:** `200`, `401`, `403`, `404`, `409`, `422`, `429`.
- **Errors:** `ARTIFACT_NOT_READY` (`409`) when the artifact exists but its bytes do not yet;
  `FORMAT_NOT_AVAILABLE` (`409`); `ADMIN_CONTENT_ACCESS_DENIED` (`403`).
- **Idempotency:** Deliberately none (§11.6) — each call mints a fresh credential.
- **Rate limiting:** its own `access_url` bucket (§14.3).
- **Side effects:** Audit record written (principal, artifact, expiry). The URL itself is
  never logged (`context.md` rule 20).

**Streaming behavior.** The signed URL supports HTTP range requests, served by object storage
(`context.md` §18.7, §13.2: "range-request MP4 is sufficient for v1"). The player issues
`Range:` headers directly to storage and receives `206 Partial Content` from storage, not
from this API. When the URL expires mid-playback, the client re-mints it and resumes at its
current byte offset; expiry is therefore short by design and refresh is expected. HLS or
segmented delivery is deferred (`context.md` §13.2) and would be an additive `format` value
under §27.

**Download behavior.** `disposition: "ATTACHMENT"` returns a URL whose response carries
`Content-Disposition: attachment` with a server-constructed filename derived from validated
book metadata — never from the uploaded filename and never from a client-supplied string
(§14.8).

**What is never returned:** the object key, the bucket name, the storage endpoint's internal
address, or any URL without an expiry. There is no endpoint anywhere in this specification
that returns a durable object-storage URL.

---

### 16.21 Platform metadata

#### Capabilities

`GET /api/v1/capabilities`

- **Purpose:** Let a client discover configured limits and provider capabilities instead of
  hardcoding them (§0). This is a **projection**, not a passthrough: it reports the
  aggregated, abstracted capability set, never a worker's address or fleet composition.
- **Authentication:** Required. **Authorization:** Any authenticated principal; the response
  is tenant-independent except for limits that are tenant-scoped.
- **Response:** `200`

```json
{
  "data": {
    "object": "capabilities",
    "api_version": "v1",
    "degraded": false,
    "limits": {
      "max_page_limit": 100,
      "default_page_limit": 25,
      "max_request_body_bytes": 262144,
      "max_upload_bytes": { "PDF": 524288000, "EPUB": 104857600, "IMAGE_SET": 2147483648 },
      "signed_url_max_expiry_seconds": 900,
      "max_batch_ids": 500
    },
    "upload": {
      "accepted_mime_types": ["application/pdf", "application/epub+zip", "image/png", "image/jpeg", "image/tiff"],
      "multipart_threshold_bytes": 104857600
    },
    "tts_providers": [
      {
        "tts_provider_id": "xtts-v2",
        "languages": ["en-GB", "en-US", "fr-FR"],
        "max_input_chars": 400,
        "native_sample_rate": 24000,
        "supports_reference_audio": true,
        "supports_embedding": true,
        "deterministic_seed": true,
        "emotion_control": "conditioning",
        "available": true
      }
    ],
    "director_versions": [ { "director_version": "director.v3", "current": true } ],
    "delivery_formats": ["M4B", "M4A", "MP3_PER_CHAPTER"],
    "vocabularies": {
      "emotion": ["NEUTRAL", "ANGER", "GRIEF", "JOY", "FEAR", "..."],
      "delivery_mode": ["NORMAL", "INTERNAL_THOUGHT", "WHISPER", "SHOUT", "LAUGHING", "CRYING", "SINGING", "READING_ALOUD"]
    }
  }
}
```

  The closed vocabularies are **owned by `director-specification.md`**; this endpoint serves
  them so a UI can render pickers without duplicating the list. `max_input_chars` is reported
  because it feeds Director chunk sizing via configuration (`context.md` §10.3) — clients read
  it, they do not set it.
- **What is never exposed:** worker counts, hostnames, VRAM, queue depths, GPU models, model
  weights locations, or any fleet detail. Those are operator metrics (§16.22, §19).
- **Status codes:** `200`, `401`.

#### Model versions

`GET /api/v1/model-versions` · `GET /api/v1/model-versions/{modelVersionId}`

- **Purpose:** Resolve the `*_model_version_id` references that appear throughout lineage, so
  an artifact can be traced to the models that produced it (`context.md` §2.4, §4.2 #22).
- **Query parameters:** `role` (`PARSER | OCR | LLM | TTS | ASR | AUDIO_TOOL`), `provider_id`,
  §10 pagination.
- **Response:** `200` collection of
  `{ id, object: "model_version", role, provider_id, model_id, version, params_fingerprint,
  released_at, deprecated_at, created_at }`. `ModelVersion` is immutable
  (`context.md` §4.5); there is no mutation endpoint.
- **Status codes:** `200`, `401`, `404`.

---

### 16.22 Administration

Administrative endpoints are `PLATFORM_ADMIN` only, are audited (§14.12), and are bound by
the content boundary of §6.6: **metadata, state, lineage, and diagnostics only — never book
text, Story Bible content, or audio bytes, and never a signed URL.**

| Endpoint | Purpose | Response / Notes |
| --- | --- | --- |
| `GET /api/v1/admin/tenants` | List tenants with usage aggregates | `200`, paginated; no content fields |
| `GET /api/v1/admin/tenants/{tenantId}` | One tenant's quotas, usage, and book **counts** | `200`; book titles are **not** returned |
| `PATCH /api/v1/admin/tenants/{tenantId}/quotas` | Adjust quotas | `200`; audited |
| `GET /api/v1/admin/users` | List users for support | `200`; `email`, roles, status; no content access |
| `GET /api/v1/admin/jobs` | Cross-tenant job list | `200`; filters `status`, `type`, `queue`, `tenant_id`, `created_after` |
| `POST /api/v1/admin/jobs/{jobId}/replay` | Replay a `DEAD_LETTERED` job after the cause is fixed (`context.md` §11.4) | `202` + a **new** job handle. `Idempotency-Key` required. `409 JOB_NOT_REPLAYABLE` unless the job is `DEAD_LETTERED` or `FAILED` terminal. Replay creates a new job with the original's lineage; it never mutates the original |
| `POST /api/v1/admin/jobs/{jobId}/cancellation` | Cancel any job | `200`; same semantics and idempotency as §16.18 |
| `GET /api/v1/admin/dead-letters` | DLQ contents with full error context | `200`, paginated; `context.md` §11.4 — nothing is silently dropped, and DLQ entries are never auto-purged |
| `GET /api/v1/admin/model-versions` | Full registry including deprecated and quarantined entries | `200` |
| `GET /api/v1/admin/workers` | Worker fleet view: worker id, advertised capabilities, loaded model versions, last heartbeat, quarantine state (`context.md` §10.4 step 9) | `200`; **internal-only detail, never mirrored to any public endpoint** |

- **Authentication:** Required, plus `PLATFORM_ADMIN`. **Authorization:** Role check plus an
  audit record per call.
- **Errors:** `FORBIDDEN` (`403`) for a non-admin principal;
  `ADMIN_CONTENT_ACCESS_DENIED` (`403`) for any attempt to reach content through an
  administrative path.
- **Async behavior:** Only `replay` is asynchronous (`202`).
- **Not offered:** impersonation, cross-tenant signed URLs, direct database or queue
  manipulation, and any endpoint that would let an administrator read a tenant's book. Those
  are deliberate non-features (§6.6).
---

## 17. Internal service APIs

Layer 2 (§3). These endpoints exist because `context.md` §24.1 permits synchronous
service-to-service calls for exactly this list: authentication and authorization checks,
metadata CRUD and reads, character reference resolution during a Director run, voice binding
resolution, context bundle retrieval, job status and progress reads, worker capability and
health queries, and presigned URL issuance.

Rules binding on every internal endpoint:

1. **Never publicly routed** (§3, rule 1).
2. Every call carries a service or worker token whose `aud` names the callee and whose
   `scopes[]` name the operation (§5.6), plus an explicit `tenant_id` — internal callers never
   infer tenancy.
3. Every call has a timeout, a retry budget (idempotent `GET`s only), and a circuit breaker
   (`context.md` §24.1).
4. **No synchronous call chain may exceed two hops** (gateway → service → service). An
   internal endpoint that would require a third hop is a boundary error.
5. Synchronous calls never trigger expensive work; they may only enqueue it and return a
   handle (`context.md` §24.1).
6. Internal endpoints use the same envelopes (§7) and the same error contract (§8), so the
   shared error taxonomy holds across both layers.
7. **Domain work is never delivered over HTTP.** Commands reach workers only through the
   queue (`context.md` §24.2).

### 17.1 Context Service — bundle retrieval

`POST /internal/v1/books/{bookId}/context-bundles`

- **Caller:** Director (`worker-ai`). **Scope:** `context:read`.
- **Purpose:** Return the bounded, ranked, six-layer context bundle for one Director request
  (`context.md` §5.4). It is on the Director's critical path and is a database plus cache
  read — **never a model call** (`context.md` §30.6).
- **Request body:** `{ tenant_id, book_id, chapter_id, scene_id, chunk_scope_id,
  spine_position, token_budget, director_version }`.
- **Response:** `200` with `{ layers: { l1..l6 }, provenance_manifest, context_bundle_hash,
  story_bible_snapshot_version, token_count, degraded, degraded_layers[] }`.
- **Degraded response:** on partial retrieval failure the bundle returns `200` with
  `degraded: true` and the missing layers named. The Director **MUST** treat a degraded
  bundle as a lower-confidence run and flag its output (`context.md` §3.2.10). It is never a
  `5xx`.
- **Hard rule:** `l6` (the chunk text) is never truncated. If the bundle does not fit, the
  response is `409 CHUNK_SPLIT_REQUIRED` and the chunk is split, never truncated
  (`context.md` §5.4 rule 1).
- **Caching:** the bundle is cacheable by
  `(book_id, spine_position, story_bible_snapshot_version, budget, director_version)`
  (`context.md` §5.4 rule 5); the response carries `cache: { hit: true|false }`.

### 17.2 Character Service — reference resolution

`POST /internal/v1/books/{bookId}/characters/resolve`

- **Caller:** Director. **Scope:** `character:resolve`. Must be fast; results are cached per
  book in Redis.
- **Request body:** `{ tenant_id, book_id, surface_form, spine_position, scene_id,
  scene_participant_ids[], speaker_context_character_id }`.
- **Response:** `200` with
  `{ character_id, resolution_strategy, confidence, is_sentinel, review_required }`.
  `resolution_strategy` is one of the ordered strategies of `context.md` §8.3 and is
  **recorded**, not merely used.
- **Binding behavior:** an unresolved reference returns the reserved `UNKNOWN_SPEAKER`
  sentinel with `review_required: true`. The service **never** invents a `Character` to make
  an ambiguity go away, and never returns a `character_id` that does not exist
  (`context.md` §8.3).

`POST /internal/v1/books/{bookId}/characters/candidates`

- **Caller:** Narrative Understanding. **Scope:** `character:write`.
- **Purpose:** Submit a new identity candidate with evidence. Creates a `PROVISIONAL`
  character surfaced for human confirmation. There is no path by which a model creates a
  `CONFIRMED` character.

### 17.3 Voice Service — binding resolution

`GET /internal/v1/books/{bookId}/characters/{characterId}/voice-binding`

- **Caller:** Director (at IR generation time). **Scope:** `voice:resolve`.
- **Response:** `200` with
  `{ voice_profile_id, voice_profile_version, tts_provider_id, tts_model_version_id,
  approval_state, speaker_reference_key, base_generation_params, base_generation_params_hash }`.
- `speaker_reference_key` is an object-storage key and is returned **only** on this internal
  endpoint, to be embedded in the IR the GPU worker receives (`context.md` §7.2). It is never
  present in any public response (§14.8).
- **Binding rule:** the resolved concrete `voice_profile_version` is written into the IR chunk
  and later into the `AudioChunk` lineage (`context.md` §9.1). This endpoint never returns a
  floating "current version" pointer for a caller to dereference later.
- Returns `409 VOICE_PROFILE_NOT_APPROVED` when the assignment is not approved — generation is
  blocked, not defaulted (`context.md` §21 row 7).

### 17.4 Director dry-run (bounded, internal only)

`POST /internal/v1/books/{bookId}/director/dry-runs`

- **Caller:** the `api` service, on behalf of a UI preview. **Scope:** `director:dry_run`.
- **Purpose:** The one synchronous Director call the architecture permits: a **single-chunk**
  preview for the UI, explicitly bounded, rate-limited, and flagged as a dry run that
  **produces no persisted artifact** (`context.md` §3.2.7, §30.6).
- **Constraints, all mandatory:** exactly one chunk; a hard wall-clock timeout; its own strict
  rate limit; no writes to `AudioScript`, `AudioScriptChunk`, or the Story Bible; no job
  created; the result is not addressable and cannot be rendered.
- **Response:** `200` with a transient IR-shaped object and `persisted: false`.
- **Not publicly exposed in v1.** Whether to surface a public wrapper for it is OQ-9 (§24).
  Until that is resolved, no public endpoint may proxy this one (§3, rule 2).

### 17.5 Job Service — internal job control

| Endpoint | Caller | Scope | Purpose |
| --- | --- | --- | --- |
| `POST /internal/v1/jobs` | Any service | `job:create` | Create a job with an explicit `tenant_id`, type, payload reference, idempotency key, priority, and dependencies. Returns the existing handle when the key already exists (`context.md` §16.3) |
| `GET /internal/v1/jobs/{jobId}` | Any service | `job:read` | Authoritative job state |
| `POST /internal/v1/jobs/{jobId}/transitions` | Worker | `job:transition` | Record a state transition with the attempt's **fencing token**. A transition presented with a stale token is refused `409 FENCING_TOKEN_STALE`, so a resurrected worker cannot write a result for a reaped attempt (`context.md` §16.5, §30.9) |
| `POST /internal/v1/jobs/{jobId}/heartbeats` | Worker | `job:heartbeat` | Liveness plus progress `(0..1, stage)` at a bounded rate. A missed deadline makes the attempt reapable |
| `POST /internal/v1/jobs/{jobId}/attempts` | Worker | `job:transition` | Create the immutable `ProcessingAttempt` record for this execution |
| `GET /internal/v1/jobs/{jobId}/cancellation` | Worker | `job:read` | Cooperative cancellation check at chunk boundaries |
| `POST /internal/v1/tts-jobs/{ttsJobId}/results` | GPU worker | `chunk:write` | Record the `AudioChunk` row and its lineage after a **verified** upload |

**Binding rule on completion.** A worker **MUST NOT** mark a chunk `GENERATED` before its
object-storage upload is verified by returned ETag/checksum (`context.md` §21 row 15, §30.9).
The results endpoint rejects a completion whose `object_verified` flag is absent with
`409 ARTIFACT_UPLOAD_UNVERIFIED`.

**Job authorization for workers.** A worker may transition only jobs it currently holds a
lease on, and every worker-issued transition is validated against the job's **recorded**
`tenant_id` (`context.md` §18.2). A worker cannot address a job it was not given.

### 17.6 Auth Service — internal

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/v1/auth/jwks` | Public keys for token verification (cached with short TTL) |
| `POST /internal/v1/auth/introspect` | Token introspection for services that cannot verify locally |
| `POST /internal/v1/auth/service-tokens` | Mint a narrow-audience service token (§5.6) |

### 17.7 What internal APIs must never do

- Expose an internal endpoint publicly, or let a public endpoint proxy one (§3 rules 1–2).
- Accept a request without an explicit `tenant_id`, or infer tenancy from the connection.
- Read or write another service's tables (`context.md` §3.1 rule 1). The Python write surface
  is limited to `AudioChunk`, `AudioScriptChunk`, `ProcessingAttempt`, and Story Bible deltas
  (`context.md` §23 row 8).
- Carry bulk content. Text and audio travel by object key (`context.md` §11.3).
- Let the TTS worker call the Director, Character, Story Bible, or Book services. There is no
  internal endpoint in this document that a GPU worker is authorized to call for narrative
  data, and there never may be (`context.md` §24.3, rule 16).

---

## 18. Worker / job interfaces

Workers are **queue consumers**, not HTTP services. Their domain contract is the job payload
(`event-contracts.md`) and the IR (`audio-script-ir.md`), not this document. What this
document fixes is the boundary:

### 18.1 How work reaches a worker

```
Public API  --creates-->  ProcessingJob  --enqueues-->  named queue  --consumes-->  worker
```

There is **no** HTTP path from any client to any worker. Job types are exactly those in
`context.md` §11.2 (§20.3); queues are exactly `parse`, `ai`, `gpu`, `audio`, `maintenance`.
No endpoint in this document accepts a queue name, a worker id, or a job type outside that
list.

### 18.2 The worker control surface

Each worker process exposes a small HTTP surface for control only (`context.md` §23 row 4:
"workers expose a small control surface; domain work still arrives via queue only"):

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness (§19) |
| `GET /ready` | Readiness: models loaded, queue reachable, storage reachable |
| `GET /internal/v1/capabilities` | The `TTSProvider.capabilities()` projection: `models[]`, `languages[]`, `max_input_chars`, `native_sample_rate`, `supports_reference_audio`, `supports_embedding`, `supports_streaming`, `emotion_control`, `deterministic_seed`, `max_batch` (`context.md` §10.2) |
| `GET /metrics` | Prometheus scrape |

- **Authentication:** service credential for `/internal/v1/**` and `/metrics`; none for
  `/health` and `/ready`, which are orchestrator probes and are not publicly routed.
- **Never exposed publicly**, and never mirrored into a public endpoint beyond the abstracted
  projection of `GET /api/v1/capabilities` (§16.21).

### 18.3 What a TTS worker may read

The IR chunk plus the referenced voice artifact — nothing else. `context.md` §7.1 states the
test: *a TTS worker with no database access, no book access, and no network except object
storage must be able to render the chunk correctly from the IR plus the referenced voice
artifact.* Consequently no endpoint in §17 grants a GPU worker access to the Book Service,
the Story Bible, or the Character Registry, and the worker's token scopes cannot name them.

### 18.4 Worker-reported state

Workers report through §17.5 only: attempts, heartbeats with progress, transitions with
fencing tokens, and verified results. They never write job state directly to the queue as a
source of truth, and they never publish domain events on behalf of another service.

---

## 19. Health and readiness

Three distinct questions, three distinct endpoints. Conflating them causes orchestrators to
kill healthy processes and route traffic to unready ones.

| Endpoint | Question | Semantics | Auth | Public |
| --- | --- | --- | --- | --- |
| `GET /health` | **Liveness** — is this process alive and not deadlocked? | Checks only in-process state. **Never** checks PostgreSQL, Redis, object storage, or any other service: a dependency outage must not cause the orchestrator to restart a healthy process. Returns `200` with `{ "status": "ok", "service": "api", "version": "1.4.2" }` or fails to respond at all | None | **No** |
| `GET /ready` | **Readiness** — should this process receive traffic? | Checks the dependencies this process needs to serve its own requests: database connectivity, queue connectivity, configuration validity, migrations applied, and (for workers) models loaded. `200` when ready, `503` with `Retry-After` when not. During draining it returns `503` while `/health` still returns `200` | None | **No** |
| `GET /health/dependencies` | **Dependency health** — what is the state of everything we depend on? | A detailed per-dependency report for operators: PostgreSQL, Redis, object storage, LLM runtime, GPU fleet registration, each with status and latency | Service token | **No** |
| `GET /metrics` | Prometheus scrape (`context.md` §23 row 22) | Metric names are a contract | Service token | **No** |

Binding rules:

1. **None of these are routed by the public ingress.** `context.md` §18 requires that
   sensitive infrastructure information not be publicly exposed, and dependency health is
   exactly that.
2. `/health` and `/ready` return **no infrastructure detail**: no hostnames, no versions of
   dependencies, no connection strings, no queue depths, no error text from a failing
   dependency. `/ready`'s failure body is `{ "status": "not_ready", "reason_code":
   "DEPENDENCY_UNAVAILABLE" }` — a code, never a message naming the dependency.
3. `/health/dependencies` may name dependencies because it is service-authenticated and
   operator-facing.
4. The public API expresses degradation to users through `degraded: true` on the relevant
   resource (§7.7) and `503` with `Retry-After` at the gateway (`context.md` §3.2.1) — never
   by exposing a health endpoint.

---

## 20. State vocabularies (binding)

Every vocabulary below is taken from `context.md`. The API adds none and renames none
(`context.md` §25.9, §26.1 rule 5).

### 20.1 `Book.status` — `context.md` §4.4

```
CREATED -> UPLOADED -> PARSING -> PARSED -> STRUCTURED -> ANALYZING -> ANALYZED
        -> CASTING -> SCRIPTING -> SCRIPTED -> GENERATING -> ASSEMBLING -> COMPLETED
```
Cross-cutting, reachable from any active state: `FAILED`, `CANCELLED`, `NEEDS_REVIEW`.
`NEEDS_REVIEW` is **not terminal** — it awaits a human decision and returns to the pipeline.

### 20.2 `ProcessingJob.status` — `context.md` §16.1

```
CREATED | QUEUED | RUNNING | RETRYING | BLOCKED | SUCCEEDED | FAILED | CANCELLED | DEAD_LETTERED
```

Terminal: `SUCCEEDED`, `FAILED`, `CANCELLED`, `DEAD_LETTERED`.

> **Deviation notice.** The commissioning brief listed a minimum of seven states, omitting
> `BLOCKED` and `DEAD_LETTERED`. `context.md` §16.1 defines all nine and §25.8 requires that
> "job state names match §16 exactly — the API does not invent its own vocabulary". The
> contract is the nine-state set, which satisfies the brief's "at minimum". Recorded as
> conflict C-7 in §23. `BLOCKED` is what represents "waiting on cast approval" without
> abusing `QUEUED` (`context.md` §30.4); `DEAD_LETTERED` is what makes DLQ pressure
> observable and replay a defined operation.

### 20.3 `ProcessingJob.type` — `context.md` §11.2

```
parse_book | ocr_page | normalize_text | analyze_structure
analyze_scene | build_story_bible_delta | generate_director_ir | revise_director_ir
generate_voice_preview | generate_tts_chunk
validate_audio | process_audio | verify_transcript
assemble_chapter | assemble_audiobook | encode_delivery_format
cleanup_artifacts
```
Queues: `parse`, `ai`, `gpu`, `audio`, `maintenance`. Priorities: `INTERACTIVE` >
`NORMAL` > `BULK`.

### 20.4 Artifact state vocabularies — `context.md` §4.4

| Entity | States |
| --- | --- |
| `AudioScriptChunk` | `DRAFT` → `VALIDATED` → `LOCKED` (generation started) → `SUPERSEDED` |
| `VoiceProfileVersion.approval_state` | `DRAFT` → `PREVIEW_GENERATED` → `APPROVED` → `LOCKED` → `RETIRED` |
| `VoiceProfileVersion.lock_state` | `UNLOCKED` / `LOCKED` with `locked_reason` ∈ `{USED_IN_GENERATION, USER_LOCKED}` |
| `AudioChunk` | `PENDING` → `GENERATING` → `GENERATED` → `VALIDATED` → `ASSEMBLED`, with `FAILED` / `INVALID` branches and `SUPERSEDED` |
| `Character.status` | `CONFIRMED` \| `PROVISIONAL` \| `MERGED_INTO` \| `RETIRED` |
| `BookFile.status` | `ADMITTED` \| `REJECTED` \| `QUARANTINED` |

### 20.5 Stage state vocabularies (API-derived read models)

These describe a **stage sub-resource**, are derived from job and entity state, and never
appear on a `ProcessingJob`:

| Stage | States |
| --- | --- |
| `ingestion` | `NOT_STARTED | QUEUED | PARSING | OCR | NORMALIZING | ANALYZING_STRUCTURE | PARTIAL_OCR | NEEDS_REVIEW | COMPLETED | FAILED | CANCELLED` |
| `analysis` | `NOT_STARTED | QUEUED | RUNNING | NEEDS_REVIEW | COMPLETED | FAILED | CANCELLED` |
| `director` | `NOT_STARTED | QUEUED | RUNNING | VALIDATING | COMPLETED | NEEDS_REVIEW | FAILED | CANCELLED` |
| `tts` | `NOT_STARTED | QUEUED | RUNNING | PARTIAL | COMPLETED | FAILED | CANCELLED` |
| `assembly` | `NOT_STARTED | BLOCKED | RUNNING | COMPLETED | FAILED | CANCELLED` |

Each value maps deterministically to underlying job and entity states; the mapping is part of
this contract and is a required contract test. Stage states are a **projection for clients**,
not a second state machine, and they never contradict §20.1–§20.4.

### 20.6 `upload_session.status`

`AWAITING_UPLOAD | UPLOADING | VALIDATING | ADMITTED | REJECTED | EXPIRED`

### 20.7 Story Bible status

`NOT_BUILT | BUILDING | READY | STALE | FAILED`

### 20.8 Validation outcomes — `context.md` §14.1

`PASS | WARN | NEEDS_REVIEW` for text QC; `PASS | FAIL` per technical audio check.

### 20.9 `voice_preview.status`

`GENERATING | READY | FAILED | EXPIRED` (a render status, distinct from the version's
`approval_state` — see §16.14 and conflict C-5).

### 20.10 `audiobook_project.generation_status`

`NOT_STARTED | BLOCKED | ASSEMBLING | COMPLETED | FAILED | STALE`

---

## 21. Error code registry

The API-facing projection of the shared error taxonomy (§8.3). One code, one meaning, one
status.

### 21.1 Authentication and authorization

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, malformed, or unverifiable credential |
| `TOKEN_EXPIRED` | 401 | Access token past `exp` |
| `TOKEN_REVOKED` | 401 | `jti` on the revocation list |
| `REFRESH_TOKEN_REUSED` | 401 | Rotated refresh token replayed; family revoked |
| `MFA_REQUIRED` | 401 | Second factor needed |
| `MFA_FAILED` | 401 | Invalid factor response |
| `ACCOUNT_LOCKED` | 429 | Too many failed attempts |
| `AMBIGUOUS_CREDENTIALS` | 400 | Both bearer token and session cookie presented |
| `FORBIDDEN` | 403 | Valid credential, insufficient role |
| `INSUFFICIENT_SCOPE` | 403 | Token lacks the required scope |
| `CSRF_TOKEN_INVALID` | 403 | Missing or mismatched CSRF token |
| `ADMIN_CONTENT_ACCESS_DENIED` | 403 | Administrative principal attempted content access (§6.6) |

### 21.2 Request and validation

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MALFORMED_JSON` | 400 | Body is not parseable JSON, or exceeds nesting limits |
| `MISSING_IDEMPOTENCY_KEY` | 400 | Required header absent |
| `VALIDATION_FAILED` | 422 | Field-level validation failure; see `details` |
| `INVALID_CURSOR` | 422 | Malformed, expired, tampered, or mismatched cursor |
| `INVALID_SORT_FIELD` | 422 | Sort field outside the allowlist |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Non-JSON `Content-Type` on a JSON endpoint |
| `REQUEST_TOO_LARGE` | 413 | Body above the endpoint limit |

### 21.3 Resource and state

| Code | HTTP | Meaning |
| --- | --- | --- |
| `RESOURCE_NOT_FOUND` | 404 | Generic not-found |
| `BOOK_NOT_FOUND` | 404 | Unknown or cross-tenant book |
| `CHARACTER_NOT_FOUND` | 404 | Unknown character in this book |
| `CHUNK_NOT_FOUND` | 404 | Unknown script chunk or audio chunk |
| `JOB_NOT_FOUND` | 404 | Unknown or unowned job |
| `RESOURCE_PURGED` | 410 | Hard-deleted |
| `RESOURCE_VERSION_CONFLICT` | 409 | Stale `If-Match` |
| `INVALID_STATE_TRANSITION` | 409 | The resource's state forbids this operation |
| `BOOK_HAS_ACTIVE_JOBS` | 409 | Deletion or purge attempted with live jobs |

### 21.4 Upload and ingestion

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNSUPPORTED_FILE_FORMAT` | 422 | Format outside the allowlist |
| `MIME_TYPE_MISMATCH` | 422 | Declared type disagrees with sniffed bytes |
| `FILE_TOO_LARGE` | 413 | Declared size above the per-format maximum |
| `SIZE_LIMIT_EXCEEDED` | 413 | Actual transferred bytes exceeded the limit |
| `CHECKSUM_MISMATCH` | 409 | Verified hash differs from the declared hash |
| `UPLOAD_INCOMPLETE` | 409 | Declared multipart parts missing |
| `UPLOAD_SESSION_EXPIRED` | 409 | Session TTL elapsed |
| `MALWARE_DETECTED` | 422 | Scan failed; object quarantined; terminal |
| `DECOMPRESSION_BOMB_DETECTED` | 422 | Expansion-ratio or entry-count guard tripped; terminal |
| `DUPLICATE_CONTENT_HASH` | 409 | Same content already present in this tenant (§16.6.7) |
| `BOOK_FILE_NOT_ADMITTED` | 409 | Referenced file is not `ADMITTED` |
| `INGESTION_NOT_COMPLETE` | 409 | A downstream stage was requested too early |
| `INGESTION_ALREADY_RUNNING` | 409 | Overlapping ingestion request |
| `PARSE_FAILED` | 409 | Terminal parse failure surfaced on a stage read |

### 21.5 Analysis, Director, and IR

| Code | HTTP | Meaning |
| --- | --- | --- |
| `ANALYSIS_NOT_COMPLETE` | 409 | Director requested before analysis covered the scope |
| `ANALYSIS_ALREADY_RUNNING` | 409 | Per-book sequencing lock held (`context.md` §5.5) |
| `DIRECTOR_ALREADY_RUNNING` | 409 | Overlapping Director scope |
| `DIRECTOR_VERSION_MIXING_FORBIDDEN` | 409 | Would mix Director versions in one audiobook (`context.md` §6.6) |
| `DIRECTOR_VALIDATION_FAILED` | 409 | IR failed §14.2 validation |
| `AUDIO_SCRIPT_NOT_VALIDATED` | 409 | TTS requested against unvalidated IR |
| `AUDIO_SCRIPT_COVERAGE_INVALID` | 409 | Coverage invariant violated (gap or overlap) |
| `AUDIO_SCRIPT_CHUNK_FROZEN` | 409 | Chunk `LOCKED`; create a new version instead (`context.md` §7.3) |
| `CHUNK_SPLIT_REQUIRED` | 409 | Internal: bundle cannot fit; split rather than truncate |

### 21.6 Characters and voice

| Code | HTTP | Meaning |
| --- | --- | --- |
| `SENTINEL_CHARACTER_IMMUTABLE` | 409 | Attempted mutation of a reserved sentinel |
| `ALIAS_CONFLICT` | 409 | Overlapping alias resolves ambiguously |
| `VOICE_ASSIGNMENT_CONFLICT` | 409 | Merge with differing voice assignments and no resolution given |
| `VOICE_PROFILE_LOCKED` | 409 | Write to a `LOCKED` version; create a new version |
| `VOICE_PROFILE_VERSION_IMMUTABLE` | 409 | Reference-audio or parameter change outside `DRAFT` |
| `VOICE_PROFILE_NOT_APPROVED` | 409 | Binding or generation with an unapproved version |
| `VOICE_PROFILE_IN_USE` | 409 | Delete or retire attempted while in use |
| `VOICE_ASSIGNMENT_IN_USE` | 409 | Clearing an assignment bound to locked chunks |
| `VOICE_REFERENCE_MISSING` | 409 | Preview requested with no usable speaker reference |
| `VOICE_LANGUAGE_MISMATCH` | 409 | Version does not support the book's language |
| `VOICE_MODEL_UNAVAILABLE` | 409 | No worker advertises the bound model (`context.md` §10.3) |
| `CONSENT_ATTESTATION_REQUIRED` | 422 | Reference audio without a consent attestation (`context.md` §9.3.6) |
| `PREVIEW_REQUIRED_BEFORE_APPROVAL` | 409 | Approval attempted with no `READY` preview |
| `CASTING_INCOMPLETE` | 409 | Generation blocked on unapproved speaking characters (`context.md` §15.3) |
| `PRONUNCIATION_ENTRY_CONFLICT` | 409 | Duplicate lexicon entry |

### 21.7 Generation, audio, and assembly

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AUDIO_VALIDATION_FAILED` | 409 | Technical QC failed for a chunk (`context.md` §14.3) |
| `CHAPTER_MANIFEST_INCOMPLETE` | 409 | Assembly on an incomplete chunk set without `allow_partial_preview` |
| `VOICE_CONSISTENCY_VIOLATION` | 409 | A character maps to more than one voice version in scope (`context.md` §9.1) |
| `AUDIOBOOK_IMMUTABLE` | 409 | Metadata or cover change after `READY` |
| `ARTIFACT_NOT_READY` | 409 | Access URL requested before bytes exist |
| `FORMAT_NOT_AVAILABLE` | 409 | Requested delivery format not present on the artifact |
| `CHAPTER_IMMUTABLE_AFTER_SCRIPTING` | 409 | Structural edit after scripting began |

### 21.8 Idempotency, quota, and infrastructure

| Code | HTTP | Meaning |
| --- | --- | --- |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Same key, different body |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | 409 | Original request still in flight |
| `RATE_LIMITED` | 429 | Bucket exhausted; `Retry-After` set |
| `QUOTA_EXCEEDED` | 429 | Tenant quota exhausted |
| `CONCURRENCY_LIMIT_REACHED` | 429 | Per-tenant or per-book concurrency cap |
| `JOB_NOT_REPLAYABLE` | 409 | Replay attempted on a non-terminal job |
| `FENCING_TOKEN_STALE` | 409 | Internal: reaped attempt attempted a write |
| `ARTIFACT_UPLOAD_UNVERIFIED` | 409 | Internal: completion without a verified upload |
| `INTERNAL_ERROR` | 500 | Unhandled fault |
| `UPSTREAM_ERROR` | 502 | Internal dependency returned an unusable response |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable or draining; `Retry-After` set |
| `DEPENDENCY_DEGRADED` | 503 | A required dependency is degraded beyond serving |

---

## 22. API versioning and compatibility

### 22.1 Version policy

- One public major version: `/api/v1`. A new major version requires a compatibility-breaking
  requirement and a §27 change-control task. None exists today.
- The API version is independent of `schema_version` (IR), `events.v*`, `director_version`,
  `structure_version`, and `pipeline_version`. Those travel in payloads and change on their
  own cadence (`context.md` §25.2).

### 22.2 What is additive (allowed within `v1`)

- New optional request fields with a safe default.
- New response fields — clients **MUST** ignore unknown fields.
- New endpoints and new sub-resources.
- New enum members in vocabularies `context.md` leaves open (§7.6).
- New query parameters, new filter values, new sort fields.
- New error codes — clients **MUST** treat an unknown `code` as its HTTP class.

### 22.3 What is breaking (requires a new major version)

- Renaming or removing any request or response field.
- Changing a field's type, casing, or semantics.
- Changing an HTTP status for an existing condition.
- Changing an error code string or its status mapping.
- Adding a required request field, or narrowing an existing constraint.
- Removing an endpoint, or changing its path or method.
- Changing pagination shape, cursor semantics, or default ordering.
- Changing authentication or authorization behavior for an existing endpoint.
- Adding a member to a **closed** vocabulary (§7.6).
- Changing an endpoint from synchronous to asynchronous or the reverse.

### 22.4 Deprecation

A deprecated endpoint or field emits `Deprecation: <date>` and `Sunset: <date>` headers and
is documented here with its replacement. Minimum notice is recorded in
`deployment-architecture.md`. **Response structures never change silently** — that is the
whole point of §22.3.

### 22.5 Contract tests

Every published surface requires contract tests (`context.md` rule 10). For this document
that means, at minimum: the response envelope shapes (§7), the error envelope (§8), the
status-code table (§9), pagination and cursor behavior (§10), idempotent replay (§11.3), the
`404`-versus-`403` tenancy rule (§6.4), the `405`-versus-`409` rule (§9.2), every state gate
in §16, and the stage-state mapping of §20.5.
---

## 23. Contract integrity audit

Performed by re-reading `context.md` in full after drafting §2–§22.

### 23.1 Architecture consistency — does every API respect service boundaries?

| Check | Result |
| --- | --- |
| Every public resource maps to an entity owned by exactly one service (`context.md` §4.2) | **Pass** — §4.2 map |
| No endpoint writes across an ownership boundary (voice assignment is a Voice Service resource, not a Character field) | **Pass** — §16.14, per `context.md` §30.2 |
| No endpoint exposes a worker, a queue, a Redis key, or an object-storage key | **Pass** — §3 rule 3, §14.8 |
| Frontend never reaches Redis or object storage except through signed URLs | **Pass** — §16.20; `context.md` §24.3 |
| No synchronous chain deeper than two hops | **Pass** — §17 rule 4 |
| `Scene` split ownership (Book rows / Story Bible semantics) preserved and labelled | **Pass** — §16.9 names the source of each field group |
| API introduces no entity absent from `context.md` §4.2 | **Pass** — §4.1 note; the only non-entity resources are the documented upload session and derived read models |

### 23.2 Async consistency — are expensive operations asynchronous?

Every mandatorily-asynchronous operation of `context.md` §2.3 has a `202` entry point and no
synchronous alternative:

| Operation | Endpoint | Returns |
| --- | --- | --- |
| Parsing / OCR / normalization / structural analysis | `POST .../ingestion` | `202` + job |
| Narrative analysis, all LLM inference | `POST .../analysis` | `202` + job |
| Director IR generation | `POST .../director` | `202` + job |
| All TTS inference | `POST .../tts` | `202` + job |
| Voice preview synthesis | `POST .../previews` | `202` + job |
| Audio validation and processing | Consequence of `POST .../tts` | job fan-out |
| Chapter and audiobook assembly, final encoding | `POST .../assembly` | `202` + job |
| Bulk purge | `POST .../purge` | `202` + job |

Permitted synchronous work is exactly `context.md` §2.3's list: auth, metadata CRUD, signed
URL issuance, job status and progress reads, cursor-paginated lists, single-item lookups, and
cancellation. **No endpoint requires synchronous TTS generation** (§16.15), and **no HTTP
handler in this contract invokes an LLM, a TTS model, FFmpeg, or an OCR engine** — the single
model-adjacent synchronous call, the Director dry-run, is internal, bounded, rate-limited,
and persists nothing (§17.4, per `context.md` §30.6).

### 23.3 Data consistency

- Resource fields mirror `context.md` §4.2 and §7.2 field groups; no field was renamed
  (`context.md` §26.1 rule 5).
- Immutability is expressed as `405` where the method never applies and `409` where state
  forbids it (§9.2), matching `context.md` §4.5 exactly.
- Every version-chained entity exposes `version` and a `supersedes_*` pointer, and every
  collection over them defaults to `include_superseded: false` while allowing history reads.

### 23.4 Security consistency — are ownership and authorization explicit?

Every endpoint in §16 carries an explicit Authorization line (§6.7). Tenancy is checked in
the owning service (§6.1). Cross-tenant references return `404` (§6.4). Administrative
principals cannot reach content (§6.6). No API leaks private object storage: bytes are
reachable only through short-lived, single-object, single-method signed URLs minted after an
ownership check (§16.20, §14.9).

### 23.5 Versioning consistency — are voice, Director, and audio artifacts versioned?

| Artifact | Version surfaced | Supersede chain | Lineage exposed |
| --- | --- | --- | --- |
| `VoiceProfileVersion` | `version` (monotonic) | `supersedes_version` | provider, model version, params hash, reference-audio hash |
| `AudioScript` | `version` | `supersedes_audio_script_id` | `director_version`, model version, snapshot version, content hash |
| `AudioScriptChunk` | chunk version | `supersedes_chunk_id` | schema, Director, context bundle hash, content hash |
| `AudioChunk` | `generation_version` | `supersedes_audio_chunk_id` | the **full** §2.4 lineage tuple, including `seed` and `generation_params_hash` |
| `ChapterAudio` | `version` | `supersedes_chapter_audio_id` | Director version, voice versions per character, FFmpeg version |
| `Audiobook` | `version` | `supersedes_audiobook_id` | pipeline, Director, TTS model versions, source hash |

Director version mixing is refused by default and requires an explicit recorded acknowledgement
(§16.13, `context.md` §6.6). Voice consistency is **validated at assembly**, not assumed
(§16.16, `context.md` §9.1).

### 23.6 Failure consistency — can failed jobs be inspected and retried?

- Inspected: `GET /jobs/{jobId}` (typed `error`, `retry_count`, `next_attempt_at`),
  `GET /jobs/{jobId}/attempts` (per-attempt audit), `GET .../audio-chunks?status=FAILED`
  (per-chunk failure detail with the failing check named).
- Retried: automatic retries are the job system's own concern; user-visible retry is a scoped
  stage command (`POST .../tts` with `scope: "FILTER"`), which regenerates only the failed
  units. Operator replay of dead-lettered jobs is `POST /admin/jobs/{jobId}/replay`.
- **A failed chunk is regenerable without its chapter, and a failed chapter without the book**
  (§16.15, §16.16) — `context.md` §16.4 satisfied by the scope parameter, not by a separate
  endpoint.

### 23.7 Reproducibility — can an artifact be traced to source and model versions?

Yes, through public reads alone: `AudioChunk.lineage` carries the complete `context.md` §2.4
tuple; `AudioScriptChunk` carries `source_content_hash`, `context_bundle_hash`,
`schema_version`, and `director_version`; `ModelVersion` resolves every
`*_model_version_id` (§16.21); `ProcessingAttempt` records the models a specific execution
loaded. Given a `book_id`, a client can reach every job, attempt, artifact, and model version
(`context.md` §17.5).

### 23.8 Frontend usability — can the frontend monitor long-running operations?

Polling (`GET /jobs/{jobId}`, `GET /books/{bookId}/progress`) is the baseline and is always
sufficient; SSE (`GET /books/{bookId}/events`) is the low-latency path. Both read persisted
job state (§16.19). Progress is computed from completed units, ETA carries explicit
confidence and may be `null`, and queue position is surfaced for backpressure
(`context.md` §20.5).

### 23.9 API completeness — can the whole workflow be driven through the API?

```
register/login -> POST /books -> upload-session -> completion -> POST /ingestion
 -> GET /chapters (review structure) -> POST /analysis -> GET /characters (cast review)
 -> PATCH /characters, POST /character-merges -> POST /voice-profiles + versions
 -> POST /previews -> POST /approval -> PUT /characters/{id}/voice -> GET /casting
 -> POST /director -> GET /audio-script-chunks (review) -> PATCH chunk (fix a line)
 -> POST /tts -> GET /progress, /events -> POST /tts (scope=FILTER, retry failures)
 -> POST /assembly -> GET /audiobook -> POST /audiobooks/{id}/access-urls (stream/download)
```

Every step in the `context.md` §1.3 pipeline and the §15.2 casting workflow has an API entry
point, and no step requires an operator.

### 23.10 Conflicts discovered

Conflicts with the **commissioning brief**, all resolved in favour of `context.md` per
§26.1 rule 4:

| # | Brief said | `context.md` says | Contract |
| --- | --- | --- | --- |
| **C-1** | Collection envelope key `"pagination"` | §25.3: `page: { next_cursor, has_more, limit }` | `page` (§7.2) |
| **C-2** | `error.details` is an object `{}` | §25.6: an array of `{field, issue}`, plus `trace_id`, `retryable`, `documentation_url` | Array (§8.1) |
| **C-3** | "Delete/archive book" | §4.4 defines no `ARCHIVED` state; §4.1 mandates soft delete | Soft delete via `deleted_at`; no archive concept (§16.6.1) |
| **C-4** | Roles include a "project/book owner" | §19.1 makes projects optional and v1 single-implicit; ownership is tenant-scoped | Ownership is the tenant; project roles deferred (§6.2, OQ-4) |
| **C-5** | Voice states `DRAFT, GENERATING, READY, APPROVED, LOCKED, FAILED` | §9.2: `DRAFT, PREVIEW_GENERATED, APPROVED, LOCKED, RETIRED` | Version `approval_state` uses §9.2; preview `status` uses `GENERATING/READY/FAILED/EXPIRED` (§16.14) |
| **C-6** | `POST /jobs/{jobId}/cancel` | §25.1: non-CRUD actions as **noun** sub-resources | `POST /jobs/{jobId}/cancellation` (§16.18) |
| **C-7** | Job states, seven listed | §16.1 defines nine, and §25.8 forbids inventing a vocabulary | Nine states including `BLOCKED` and `DEAD_LETTERED` (§20.2) |

Conflicts **within `context.md` itself** — reported, not silently resolved:

| # | Location | The tension | How this document proceeds |
| --- | --- | --- | --- |
| **I-1** | §4.3 `Book ─1:N─ VoiceProfile` vs §19.1 "tenant-scoped library, book-scoped assignments" and §9.2 "tenant/book scope" | Is a `VoiceProfile` owned by a book or by a tenant? | Reconciled with an explicit `scope` field (`TENANT | BOOK | SYSTEM`), which satisfies both readings. Flagged as **OQ-1**; needs a §27 confirmation before implementation |
| **I-2** | §25.1 "Nouns, plural, kebab-free lowercase: `/books`, `/voice-profiles`" | "kebab-free" contradicts its own examples, which are hyphenated | Adopted the examples: lowercase, hyphenated multi-word segments (§2.3). Flagged as **OQ-2** |
| **I-3** | §14.5 and Appendix A require a "review item" surface; §4.2 has no `ReviewItem` entity | QC findings have no entity home | No review-item endpoint invented. Review information is surfaced as `review_flags` on chunks, `needs_review_count` on the book and progress, and `NEEDS_REVIEW` states. Flagged as **OQ-3** |
| **I-4** | §3.2.7 lists "Director run records" as persistent data; §4.2 has no such entity | Director run history has no entity | Modelled as `AudioScript` (§4.2 #14, which carries Director version and config) plus `ProcessingJob` history. No new entity introduced. Flagged as **OQ-10** |
| **I-5** | §3.2.13 lists `ValidationReport` as persistent data; §4.2 does not list it | Validation reports have no entity row | Surfaced as a `validation` field group on `AudioChunk` and `ChapterAudio` rather than as a resource. Flagged as **OQ-11** |
| **I-6** | §3.2.2 tokens carry `roles`; no role vocabulary exists anywhere | Authorization cannot be specified without role names | Minimum provisional set defined in §6.2 and marked provisional. Flagged as **OQ-5** |

**No conflict was resolved by weakening `context.md`.** Where this document had to choose, it
chose the Tier 0 reading and recorded the choice.

### 23.11 Invented assumptions check

Items this document introduces that are **not** literally in `context.md`, each justified as a
mechanical consequence of an existing rule rather than a new architectural decision:

| Introduced | Justification | Risk |
| --- | --- | --- |
| `snake_case` decision | `context.md` §25.1 explicitly delegates the choice (Q7) | None — it is the delegated decision |
| The stage sub-resource convention | §25.1 mandates non-CRUD actions as sub-resource commands that create a job | None |
| `page.prev_cursor`, `page.total` | Additive to §25.3's shape (§22.2) | Low |
| `object` type discriminator on resources | Presentation of §4.2's entity identity | Low |
| Stage state vocabularies (§20.5) | Derived projections; explicitly not a second state machine | Low — needs a contract test proving the mapping |
| `access-urls` sub-resource shape | §18.7 and §25.8 require signed-URL issuance; the shape is this document's to define | Low |
| `capabilities` endpoint | §10.3 requires capability negotiation; the client-facing projection is new | Low — deliberately abstracted |
| Provisional role names (§6.2) | Required to specify authorization at all | **Flagged, OQ-5** |
| `VoiceProfile.scope` field | Reconciles I-1 | **Flagged, OQ-1** |
| `auto_ingest` book setting (§16.6.7) | Needed to decide whether admission auto-starts parsing | **Flagged, OQ-12** |

---

## 24. Open architectural questions

These are **unresolved**. Each names the affected `context.md` section, the options, and this
document's interim position. An implementation phase **MUST NOT** resolve one by choosing
silently (`context.md` rule 13); resolution requires a §27 change-control task and an update
to `context.md` first.

| # | Question | Affected | Options | Interim position |
| --- | --- | --- | --- | --- |
| **OQ-1** | Is `VoiceProfile` tenant-scoped, book-scoped, or both? | `context.md` §4.3, §9.2, §19.1 | (a) tenant-only with book assignments; (b) both, distinguished by a `scope` field; (c) book-only with a separate library entity | (b): `scope ∈ {TENANT, BOOK, SYSTEM}` (§16.14). Needs confirmation before `database-schema.md` is written |
| **OQ-2** | Are multi-word path segments hyphenated? | §25.1 | (a) hyphenated (`/voice-profiles`); (b) single-word only | (a), following §25.1's own examples (§2.3) |
| **OQ-3** | Does a `ReviewItem` entity exist? | §14.5, §4.2, Appendix A | (a) add the entity under §27; (b) keep review as flags and counters only; (c) derive a read-only projection | (b) for v1: no review-item endpoint. §14.5 asks for a surface with "a direct link to the offending chunk, its text, its audio, and a one-click regenerate/edit action", which flags and counters satisfy only partially. **This is the most likely v1 gap** |
| **OQ-4** | Is there collaboration or sharing, and what are project-scoped roles? | §19.1, §18.2 | (a) tenant-only in v1; (b) project roles now | (a). No sharing endpoint exists (§6.2) |
| **OQ-5** | What is the role vocabulary? | §3.2.2, §18.2 | Any | The provisional set in §6.2 |
| **OQ-6** | What are the MFA enrolment and email-change contracts? | §18.1 | Any | Reserved; not specified; must not be invented (§5.5) |
| **OQ-7** | Are programmatic API keys offered, and to whom? | §18.1 | (a) none in v1; (b) scoped, hashed, revocable keys | (a). §18.1 permits them "if added", which is not a v1 requirement |
| **OQ-8** | May a user edit scene boundaries? | §4.2 #6, §30.2 | (a) read-only; (b) editable with re-analysis | (a) in v1 (§16.9) |
| **OQ-9** | Should the Director dry-run be publicly exposed? | §3.2.7, §30.6 | (a) internal only; (b) a public, strictly rate-limited wrapper | (a) (§17.4). A public wrapper would be additive but needs an explicit rate and abuse model |
| **OQ-10** | Do "Director run records" need their own entity? | §3.2.7 vs §4.2 | (a) `AudioScript` + `ProcessingJob` suffice; (b) add the entity | (a) (§23.10 I-4) |
| **OQ-11** | Does `ValidationReport` need its own entity and resource? | §3.2.13 vs §4.2 | (a) field group on the artifact; (b) first-class entity | (a) (§23.10 I-5) |
| **OQ-12** | Does admitted upload auto-start ingestion? | §3.2.5, §4.4 | (a) always auto; (b) always explicit; (c) a per-book setting | (c) `auto_ingest`, default `true` (§16.6.7). Needs confirmation because it changes the meaning of the `CREATED` job returned at finalization |
| **OQ-13** | Are notification preferences and webhooks part of the public API? | §3.2.15 | (a) not in v1; (b) preferences only; (c) preferences plus webhooks | (a) (§15.18). Webhooks additionally need an SSRF egress model (§14.7) |
| **OQ-14** | Should `total` counts ever be served for chunk-scale collections? | §25.3 | (a) never; (b) on request with a cap; (c) always | (b): `include_total` may return `null` on very large collections (§10.1) |
| **OQ-15** | May a user download the canonical text or parsed artifacts? | §12.1, §18.11 | (a) yes, own tenant only; (b) no | (a) via `POST .../text/access-urls`. Flagged because §18.11's copyright posture may argue for narrowing it |

---

## 25. Rules for Future Implementation

These rules are binding on every implementation session that touches the HTTP surface. They
sit under, and never above, `context.md` §28.

1. **This file is the authoritative API contract.** For endpoints, paths, methods, payload
   shapes, field names, casing, status codes, error codes, pagination, idempotency, and
   authentication behavior, this document is the source of truth. Code conforms to it; it is
   not retro-fitted to code.
2. **Implementations must follow it exactly.** Not approximately, not "in spirit". If the
   implementation and this document disagree, the implementation is a defect
   (`context.md` §2.1, §28 rule 2).
3. **Do not rename endpoints casually.** A path is a contract. `/audio-script-chunks` does
   not become `/chunks` because it is shorter.
4. **Do not rename request fields.** Not for consistency with a library, not for a framework
   convention, not to match a database column.
5. **Do not rename response fields.** Clients depend on every name in §16.
6. **Do not change status codes without an approved contract change.** The `405`-versus-`409`
   rule (§9.2) and the `404`-versus-`403` rule (§6.4) are behavior, not style.
7. **Do not change authentication or authorization behavior without updating this contract
   first.** That includes token lifetimes' *semantics*, cookie attributes, scope
   requirements, and the tenancy-disclosure rule.
8. **Do not add undocumented public endpoints.** If a client needs something that is not
   here, stop and report it (rule 14). A new endpoint is an Additive change requiring an ADR
   (`context.md` §27.4).
9. **Do not remove documented endpoints.** Removal is Breaking and requires a major version.
10. **Do not silently change asynchronous behavior.** An endpoint that returns `202` never
    starts returning `200`, and a synchronous endpoint never starts enqueueing. Moving work
    between synchronous and asynchronous is Breaking (§22.3).
11. **Do not bypass validation.** Both layers (§12.1) are mandatory. Strict mode stays on:
    unknown fields are rejected, never ignored. LLM output passes the full §12.5 chain before
    it can appear in a response.
12. **Do not expose internal service endpoints publicly.** `/internal/v1/**`, `/health`,
    `/ready`, `/health/dependencies`, and `/metrics` are never routed by the public ingress,
    and no public endpoint proxies one (§3).
13. **Do not modify this contract during an implementation phase** unless the task explicitly
    authorizes an architecture change. Contracts freeze when their phase begins
    (`context.md` §27.3).
14. **If implementation requirements conflict with this document, stop and report the
    conflict** — name the endpoint, the section, and the options. Do not pick one and proceed
    (`context.md` §28 rules 13–14).

Additional standing rules specific to this API surface:

15. **Never return an object-storage key, a bucket name, a queue name, a Redis key, a worker
    hostname, or a permanent URL to a public client.** Bytes are reached only through
    `.../access-urls` (§16.20).
16. **Never claim completion in a `202`.** `accepted` describes admission, never outcome
    (§7.3, §9.3).
17. **Never invent a job state, a job type, an event name, or an entity.** They come from
    `context.md` §16.1, §11.2, §11.3, and §4.2 respectively (§20).
18. **Never mutate a locked or immutable resource through any endpoint, and never add a force
    flag that would.** `VoiceProfileVersion` in `LOCKED`, frozen `AudioScriptChunk`s,
    `AudioChunk`, `ChapterAudio`, `Audiobook`, `ProcessingAttempt`, `NarrativeState`, and
    `BookFile` are immutable; the answer is always a new version (`context.md` §2.5, §9.3).
19. **Never let an HTTP handler invoke an LLM, a TTS model, OCR, or FFmpeg** — not even for
    "just the small case" (`context.md` §2.3, §28 rule 19).
20. **Never enforce ownership only at the gateway.** The owning service checks tenancy on
    every access (§6.1).
21. **Never log or return a signed URL, a token, or book text** (`context.md` §28 rule 20,
    §8.2).
22. **Never add a client-supplied prompt, instruction, or model-parameter field to any public
    endpoint.** Director behavior is selected by `director_version` only (§14.10).
23. **Never accept a URL from a client for the server to fetch** (§14.7).
24. **Never introduce `/api/v2`** without a documented compatibility-breaking requirement and
    a §27 approval (§2.1, §22.1).

---

## Appendix A — Document status

| Field | Value |
| --- | --- |
| Version | `api-spec.v1.1` |
| Status | DRAFT — awaiting human review |
| Tier | 1 (contract of record for the HTTP surface) |
| Derives from | `context.md` (`context.v1`) |
| Frozen | No. Freezes when its implementation phase begins (`context.md` §27.3) |
| Change protocol | `context.md` §27 |
| Depends on (for full specification) | `database-schema.md`, `event-contracts.md`, `audio-script-ir.md` — per `context.md` §26.2 these are written **before** this document is finalized; where they are not yet written, this document names the obligation rather than inventing the detail |
| Open questions | 15 (§24) |
| Conflicts recorded | 7 with the commissioning brief, 6 within `context.md` (§23.10) |
| Corrections in `v1.1` | §16.13's `emotion_capability_map` example and the Audio Script chunk resource's `"emotion": "ANGER"` example both corrected to `"ANGRY"` (a valid `emotion` vocabulary member); the chunk resource gains `content.spoken_text_substitutions`, `performance.non_verbal`, `quality.decision_confidence`, `quality.continuity`, and a new `provenance` field group (`origin`/`director_original`/`override`), closing `audio-script-ir.md` §63.2's IR-11 amendment obligation against this document. See `architecture-review.md`'s Blocker Closure Addendum |

> **Dependency-order note.** `context.md` §26.2 places `database-schema.md`,
> `event-contracts.md`, and `audio-script-ir.md` **before** `api-specification.md` in the
> writing order, and states that writing a downstream document reveals gaps upstream which
> are fixed upstream first. This document was written ahead of those three. Every place where
> it would otherwise have had to invent a persistence detail, a queue payload, or an IR field
> type, it names the owning document instead. The six internal tensions in §23.10 and the
> fifteen open questions in §24 are exactly the upstream gaps that writing it revealed, and
> they are reported rather than resolved.
