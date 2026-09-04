# Frontend Architecture — Audiobook Studio (`apps/web`)

> **Status:** Phase 9. Describes what is implemented, not what is planned.
> Where a capability is specified but absent, this document says so and names
> the gap rather than describing it as if it existed.
>
> The authority for everything the studio calls is
> `docs/architecture/api-specification.md`. `api-usage-guide.md` and
> `error-handling.md` are the client-facing companions this app is built
> against. Gaps are catalogued in `frontend-api-gaps.md`.

---

## 1. What this is

`context.md` §3.1 names five v1 deployables, the first of which is:

| Deployable | Runtime | Contains |
| --- | --- | --- |
| **`web`** | Next.js / Node | Frontend app + BFF calls to `api` |

This is that deployable. §1933 of the same document fixes the stack — **Next.js
App Router + TypeScript**, with "a colocated BFF for session handling" — and
records the binding constraint: _"Frontend never talks to Redis/object storage
directly; all access via `api`."_

```
                         BROWSER
                            │  same-origin only
                            ▼
              ┌──────────────────────────┐
              │  apps/web  (Next.js)     │
              │  ┌────────────────────┐  │
              │  │ React Server +     │  │
              │  │ Client Components  │  │
              │  └─────────┬──────────┘  │
              │            │ /bff/api/v1 │
              │  ┌─────────▼──────────┐  │
              │  │ BFF proxy          │  │  httpOnly cookie → Bearer
              │  │ session boundary   │  │  origin check, path allowlist
              │  └─────────┬──────────┘  │
              └────────────┼─────────────┘
                           ▼
                 APPLICATION API  /api/v1/**
                           │
                    (Phase 1–8 engine)

     audio bytes:  BROWSER ──signed URL──► OBJECT STORAGE
                            (never through web, never through api)
```

Two paths leave the browser and only two: same-origin requests to `/bff`, and
direct `GET`s to short-lived signed object-storage URLs the API minted. The
browser never learns the API's address, never holds a credential, and never
sees a storage key or bucket name.

---

## 2. The BFF, and why the credential lives there

`src/lib/server/proxy.ts` is the whole client-to-API path. It buys four
properties, none of which a direct browser→API call has:

| Property | How |
| --- | --- |
| The bearer never enters the browser's JS heap or storage | Read from an httpOnly cookie **server-side**, attached server-side |
| CSRF | `SameSite=Lax` on the cookie, plus an explicit `Origin` check on every unsafe method |
| Only the public surface is reachable | Path allowlist `^api/v1/` — `internal/v1/**`, `/metrics`, and `/health/dependencies` are not proxied at all |
| SSE works without a token in a URL | `EventSource` cannot set headers; the same-origin cookie is exchanged for the bearer at the proxy. `api-usage-guide.md` §7 forbids a credential in a query parameter because URLs are logged |

Response bodies are **streamed, never buffered**, which is what lets one handler
carry both a JSON read and an open-ended SSE stream. Audio deliberately does not
pass through: a twenty-hour audiobook is fetched by the browser from storage.

### The session boundary, and where issuance now happens (Phase 10)

`src/lib/server/session.ts` verifies a bearer token against the *same*
issuer, audience, and key material `JwtAuthGuard` uses, then stores it in a
cookie — that verification code is unchanged from Phase 9. What changed is
where the token comes from: `src/lib/server/auth-client.ts` calls the now-
implemented `POST /api/v1/auth/{login,register,logout}` (§16.1, GAP-1
resolved) directly against the application API — server-side, not through
`/bff`, since register/login have no session yet and logout is managing the
one that exists. `session.ts` itself still mints nothing and signs nothing;
it only ever verifies and stores what `auth-client.ts` (or, in principle, any
other identity provider issuing a compatible token) hands it.

Route protection (`src/middleware.ts` + `(studio)/layout.tsx`) is **UX only**.
The API checks ownership on every resource and answers `404` for anything
outside the caller's tenant; deleting those files would change what a user
*sees*, not what they can reach.

---

## 3. Server state

| Concern | Where |
| --- | --- |
| Every API call | `src/lib/api/client.ts` — no raw `fetch` in any component |
| Error normalization | `src/lib/api/errors.ts` — one `ApiError`, one presentation map |
| Cache keys | `src/lib/query/keys.ts` — invalidation is a prefix match, never a hand-maintained list |
| Polling policy | `src/lib/query/polling.ts` |
| Live updates | `src/lib/query/useEventStream.ts` |
| Resource hooks | `src/lib/query/hooks.ts` |

**Retry.** The transport retries only safe methods, only when the API's own
`retryable` is true, with full-jitter backoff honouring `Retry-After`. Query-
level retry is **off**: a second policy layered on the first would multiply
request volume against a per-tenant bucket for no extra resilience. Mutations
never retry — repeating an expensive stage command on the client's initiative is
exactly what rule 78 forbids.

**Idempotency.** `Idempotency-Key` is minted once per confirmed intent and
reused across retries of that intent, which is what makes a retry after a
network timeout safe.

**Optimistic concurrency.** `ETag` from the last read is sent as `If-Match` on
metadata writes, so two open tabs get `409 RESOURCE_VERSION_CONFLICT` instead of
silently clobbering.

### Polling and SSE

`api-usage-guide.md` §7: _"HTTP polling is the baseline and is always
sufficient"_; SSE exists to spare the client a *fast* poll. Both are used, and
the intervals say so:

| Situation | Interval |
| --- | --- |
| Work running, no stream | 5 s — the fastest this app ever polls |
| Work running, stream connected | 30 s — a backstop, not the freshness mechanism |
| Idle, stream connected | Off |
| Idle, no stream | 60 s |
| Terminal resource | Off |

An SSE frame never *updates* the cache — it invalidates it, and the subsequent
read re-derives state from the database. That is why a missed event is harmless,
and it is what makes reload (rule 45) and multi-tab (rule 46) correct by
construction rather than by convention. Invalidation is coalesced over 800 ms
and scoped to the book's key prefix: a generating book emits thousands of
`tts.chunk_completed` frames, and routing each to a key set would be a second,
drifting copy of `event-contracts.md` §12.

---

## 4. Status, and the one place it is decided

`src/lib/status.ts` is the only module that turns backend state into a label, a
tone, or a next action (rules 9, 10, 171). It maps four independent
vocabularies, none derived from another by guesswork:

| Vocabulary | Source |
| --- | --- |
| `Book.status` (16) | `GET /books/{id}` |
| `ProcessingJob.status` (9) | `GET /jobs/{id}` |
| Stage states (10) | the derived projection in `GET .../progress` |
| `audiobook_project.generation_status` (6) | `GET .../audiobook` |

Every value is mapped, every unrecognized value degrades to "Unknown" rather
than crashing, and `nextActionForBook` gives all sixteen book states a next
step — so no state is a dead end (rule 170). `src/lib/status.test.ts` asserts
both properties over the whole enum.

Status is never communicated by colour alone: `StatusBadge` carries a text
label, a per-tone glyph *shape*, and colour, so it survives greyscale and a
screen reader.

### `null` is not `0`

The rule the API guide states and a naive UI gets wrong. `total_units: null`
means the denominator is not yet knowable — no script exists, so nobody knows
how many chunks TTS will render. The studio renders that as an indeterminate
"Preparing…" bar with **no `aria-valuenow` at all**, never as 0%. Likewise
`estimate.confidence: "NONE"` renders as nothing: the server declined to guess,
and the client does not substitute one.

---

## 5. Routing

Every screen is addressable, so a refresh or a bookmark lands in the same place
(rules 107, 108).

```
/                                     dashboard
/projects                             library (status filters, cursor pages)
/projects/new                         create + upload
/projects/{id}                        overview
/projects/{id}/book                   source file, metadata, structure
/projects/{id}/characters             cast registry
/projects/{id}/characters/{id}        character + voice
/projects/{id}/voices                 casting workspace
/projects/{id}/generation             configure, run, watch, cancel
/projects/{id}/review                 flagged passages
/projects/{id}/chapters               chapter production list
/projects/{id}/chapters/{id}          chapter detail + player
/projects/{id}/audiobook              player, versions, download
/projects/{id}/jobs                   activity log
/voices                               voice library
/settings                             account, quotas, limits
/sign-in                              session boundary
/bff/api/v1/**                        the BFF proxy
```

No "Admin" section exists: `/api/v1/admin/**` requires `PLATFORM_ADMIN`, and
§6.6 makes that principal unable to read tenant content at all, so an operator
console is a different product surface rather than a tab here.

---

## 6. Scale

| Pressure | Approach |
| --- | --- |
| 100+ chapters | Fetched once (bounded by one project), rendered through a fixed-height window — ~30 nodes for 400 rows |
| 50+ characters | Same window; filter and sort over the fully-fetched cast, labelled as such (GAP-4) |
| 10 000+ TTS chunks | **Never enumerated.** Only the server's aggregates are shown (rule 42) |
| Tenant-wide book list | Server-side cursor pagination, never fully fetched |
| 10+ hour audiobook | One signed URL, `preload="none"`, chapter navigation by seeking to a manifest offset. Object storage serves byte ranges as playback advances |

The windowing is ~50 lines (`useVirtualRows`) rather than a virtualization
library: both lists are uniform-height rows, so a general-purpose virtualizer
would add ~15 kB for nothing.

---

## 7. Bundle

| Measure | Value |
| --- | --- |
| Shared first-load JS | **102 kB** |
| Largest route first-load | 137 kB (`/projects/{id}/generation`) |
| Total client JS emitted | ~1.27 MB across all routes |
| Runtime dependencies | `next`, `react`, `react-dom`, `@tanstack/react-query`, `clsx`, `jose` (server-only), `server-only` |

No component library, no CSS-in-JS runtime, no icon package (icons are inline
SVG), no date library (`Intl` covers it), no virtualization library. `jose` is
imported only from modules guarded by `server-only`, so it cannot reach the
client.

---

## 8. Security posture

| Concern | Measure |
| --- | --- |
| Credential storage | httpOnly cookie, `SameSite=Lax`, `Secure` + `__Host-` prefix outside plain-HTTP development. Asserted by test |
| CSRF | `SameSite` plus an `Origin` check on every unsafe proxied method |
| XSS | Book text is untrusted and rendered as React text nodes. There is exactly **one** `dangerouslySetInnerHTML` in the codebase — a static theme-bootstrap string with no interpolation — and no markdown or HTML renderer anywhere |
| Open redirect | `safeReturnPath` rejects absolute, protocol-relative (`//`), and backslash-escaped URLs |
| Storage paths | Never constructed. Every binary is a signed URL minted by the API from ids the API returned |
| Secrets in the bundle | No `NEXT_PUBLIC_` variable exists. Asserted against the real production bundle in the Playwright suite |
| Surface reachable from the browser | `^api/v1/` only |
| Response headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; `no-store` on every proxied response |

### Telemetry

No analytics or error-tracking provider is configured in this deployment, and
rule 155 forbids shipping content to one that is not. Unhandled errors are
recorded to the console with Next's `digest` — a hash carrying no message,
stack, or path. If a provider is added later, the constraint is that book text,
audio, signed URLs, and tokens must never leave the application.

---

## 9. Testing

| Layer | Count | What it covers |
| --- | --- | --- |
| Unit | 67 | Formatting, status mapping, error presentation, generation plan, casting derivation, polling policy, upload validation, redirect guard |
| Integration (MSW) | 20 | The real client against the real envelopes, over the full status matrix: 400/401/403/404/409/422/429/500/502/503 |
| Component | 83 | Buttons, dialogs, forms, progress, status, players, voice selector, review item, project card, dashboard |
| Server | 25 | BFF proxy allowlist, origin check, header hygiene; token verification and cookie flags |
| Contract | 19 | Every path the studio calls, checked against `api-specification.md` §15; every hard-coded vocabulary, checked against the JSON Schemas |
| Accessibility (jsdom) | 9 | axe scan on nine surfaces |
| **Vitest total** | **223** | |
| E2E (Playwright) | 46 scenarios, **139 executions** | Chromium, Firefox, WebKit, and a mobile viewport. The axe and keyboard-traversal scans run on one engine, hence 139 rather than 184 |

MSW intercepts at the network layer, so component tests exercise the shipping
client, error normalization, and query layer — only the transport is faked, and
an unhandled request is a test failure rather than a silent pass.

The Playwright suite runs the **production build**, not the dev server (rule
185), against a stateful API stand-in that enforces the same preconditions the
real API does — casting before TTS, cooperative cancellation, supersede-not-
overwrite.

---

## 10. Files

```
apps/web/
  src/app/                        routes; (studio) is the authenticated shell
    bff/[...path]/route.ts        the only browser→API path
  src/components/
    ui/                           Button, Dialog, Toast, Panel, Table, Field,
                                  ProgressBar, StatusBadge, Pagination, States,
                                  Skeleton, ScrollRegion
    shell/                        AppShell, ThemeToggle
    project/ characters/ voices/ generation/ review/ chapters/
    audiobook/ audio/ dashboard/ settings/
  src/lib/
    api/                          client, errors, types
    query/                        keys, provider, polling, hooks, useEventStream
    server/                       env, session, proxy, actions, auth-client   (server-only)
    status.ts casting.ts generation.ts format.ts upload.ts
    safe-redirect.ts vocabularies.ts cn.ts chapter-status.ts
    hooks/                        useCursorPagination, useVirtualRows,
                                  useSignedAudio, useUnsavedChangesWarning
  src/middleware.ts               route protection + path propagation
  e2e/                            Playwright suite + stateful API stand-in
infra/docker/web.Dockerfile
```
