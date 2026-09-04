# Phase 9 Report — Audiobook Studio (frontend)

> Scope: `apps/web` — the production web application, its BFF, its tests, and
> its deployment. No Phase 1–8 code was changed to make the frontend easier
> (rule 162). Two repository-level files were touched and both are listed in §7.

---

## 1. What Phase 9 built

There was **no frontend at all** before this phase. `context.md` §3.1 named a
`web` deployable and §1933 fixed its stack; neither existed. Phase 9 is that
deployable: 20 routes, a component library, a BFF session boundary, 223 unit and
component tests, and a 46-scenario end-to-end suite run across four browser
engines against the production build.

The stack is the one the architecture already chose — **Next.js App Router +
TypeScript + Tailwind** — so §4's "use the existing stack" was satisfied by
adopting rather than by justifying a replacement.

Runtime dependencies, total: `next`, `react`, `react-dom`,
`@tanstack/react-query`, `clsx`, `jose` (server-only), `server-only`. No
component library, no CSS-in-JS runtime, no icon package, no date library, no
virtualization library.

---

## 2. The architectural rule, and how it is enforced

Rule 1: the frontend is a client of the Phase 8 API and must not reach Postgres,
Redis, object storage internals, providers, workers, or internal queues.

It is enforced in three places rather than asserted once:

1. **The proxy allowlist.** `^api/v1/` and nothing else. `internal/v1/**`,
   `/metrics`, and `/health/dependencies` return `404` from the BFF and are
   never dialled. Asserted by `proxy.test.ts` and by an E2E test.
2. **A contract test that reads the specification.** `endpoints.test.ts`
   extracts every `/api/v1/...` literal the studio constructs, normalizes its
   template parameters, infers the verb from the call site, and asserts each
   `METHOD path` pair appears in the §15 endpoint tables of
   `api-specification.md`. A path invented in a component fails the build.
3. **A grep for storage internals.** The same test asserts no source file
   mentions `s3://`, `storage_key`, or `storage_bucket`.

Audio never passes through either `web` or `api`: the browser fetches it from a
short-lived signed URL, and object storage serves the byte ranges.

---

## 3. Scorecard

| Area | State | Evidence |
| --- | --- | --- |
| Workflow coverage | **COMPLETE** | Dashboard → create → upload → ingestion → structure → characters → voices → configuration → generation → progress → review → chapter preview → player → download, all implemented and E2E-tested |
| Architectural boundary | **COMPLETE** | §2 above |
| Status model | **COMPLETE** | One mapping module; all 16 book states, 9 job states, 10 stage states, 6 generation states mapped; unknown values degrade rather than crash |
| No fabricated progress | **COMPLETE** | `null ≠ 0` enforced in the formatter, the progress primitive, and the accessibility tree; asserted by unit, component, and E2E tests |
| Error handling | **COMPLETE** | One `ApiError`, one presentation map covering every code the application layer produces, status-class fallback for codes added later |
| Real-time | **COMPLETE** | SSE via the BFF with adaptive polling backstop; no second realtime system |
| Reload / multi-tab | **COMPLETE** | No authoritative client state; both E2E-tested |
| Accessibility | **READY WITH CONDITIONS** | Zero axe violations across 9 jsdom scans and 10 real-browser WCAG 2.2 AA scans; keyboard traversal, dialog focus return, and reduced motion tested. **Not** validated with a real screen reader — see §6 |
| Responsive | **COMPLETE** | Mobile, tablet, desktop; no horizontal page scroll at any width |
| Security | **COMPLETE** | §5 |
| Performance | **COMPLETE** | 102 kB shared first-load JS; windowed lists; adaptive polling; nothing preloaded |
| Voice preview | **BLOCKED** | GAP-7 — the byte-access endpoint is specified but unimplemented. No control is rendered |
| Cover art | **BLOCKED** | GAP-3 — no read path exists in the specification. A labelled placeholder is drawn |
| Project search / sort | **BLOCKED** | GAP-6 — no controls rendered, rather than faked |
| Review approve / reject | **BLOCKED** | GAP-8 — reserved, not specified. The actions that do exist are offered under their real names |

---

## 4. Findings

Four defects were found by the suites and fixed. All four were found by
automation, not by inspection — which is the argument for the suites.

### P9-1 — Muted text failed WCAG 1.4.3 (fixed)

`--text-muted` at `oklch(58%)` measured ~3.3:1 on the white panel, against the
4.5:1 body-text threshold. It is used for secondary navigation, timestamps, and
counts, so it affected every page.

Found by the **Playwright** axe run, not the jsdom one: jsdom computes no layout
and resolves no CSS custom properties, so it cannot evaluate contrast — which is
exactly why the browser scan exists. Fixed by moving light-mode muted text to
`oklch(48%)` and dark-mode to `oklch(72%)`, and by darkening the accent and tone
colours for the same reason.

### P9-2 — `role="region"` on a `<ul>` destroyed list semantics (fixed)

Three scroll containers were `<ul>` elements carrying `role="region"` and
`tabIndex` so their overflow would be keyboard-reachable. The explicit role
**overrides** the implicit list role, orphaning every `<li>` and destroying the
"list of N items" announcement.

Found by the jsdom axe scan (`listitem`, serious). Fixed by extracting
`ScrollRegion`: the scroll affordance and the list semantics now live on
different elements. The component carries the explanation so it is not
reintroduced.

### P9-3 — Horizontal page scroll on mobile (fixed)

The project workspace scrolled sideways by 358px on a 390px viewport. The
project navigation is a horizontally scrolling tab strip, and its `<nav>` is a
grid item — which defaults to `min-width: auto`, letting content set the
column's width regardless of the inner `overflow-x-auto`.

Found by the responsive E2E suite, which asserts
`scrollWidth - clientWidth <= 1`. Fixed with `min-w-0`, annotated as
load-bearing.

### P9-4 — Sign-in discarded the requested page (fixed)

An unauthenticated visitor to a deep link was redirected to `/sign-in` with no
`returnTo`, so signing in dropped them on the dashboard — a violation of rule 76.

Found by the authentication E2E test. Fixed by adding `src/middleware.ts`, which
redirects with `returnTo` and forwards the requested path as a header so the
studio layout can do the same for a *present but expired* token, which a Server
Component cannot otherwise learn.

### Open, by design — not defects

| Item | Why it stays open |
| --- | --- |
| GAP-1 … GAP-8 | Backend capabilities that do not exist. Reported in `frontend-api-gaps.md` with a proposed contract change each; none was worked around silently |
| No screen-reader validation | Automated scanning catches roughly a third of WCAG failures. See §6 |
| No Lighthouse / Core Web Vitals numbers | See §6 |

---

## 5. Security audit

| Check | Result |
| --- | --- |
| Token storage | httpOnly cookie, `SameSite=Lax`, `Secure` + `__Host-` prefix outside plain-HTTP dev. E2E asserts `localStorage`, `sessionStorage`, and `document.cookie` contain no token |
| CSRF | `SameSite` + explicit `Origin` check on unsafe methods. A cross-origin `POST` is `403`, asserted end to end |
| XSS | Book text rendered as React text nodes throughout. **One** `dangerouslySetInnerHTML` in the codebase — a static theme-bootstrap string with no interpolation. No markdown or HTML renderer exists. E2E asserts markup in book text is displayed, not applied, and that no dialog fires |
| Prompt injection | Book text is displayed as content, never interpreted. No book-derived string reaches an executable context |
| Open redirect | Absolute, protocol-relative (`//`), and backslash-escaped return paths rejected; unit- and E2E-tested |
| IDOR | Not the frontend's boundary — the API answers `404` cross-tenant. The studio never constructs an id it was not given |
| Signed URLs | Minted on demand, never cached or persisted, re-minted on expiry. Never logged |
| Secret leakage | No `NEXT_PUBLIC_` variable exists. The **production bundle** is scanned in CI for the API address, key material, and JWT-shaped strings |
| Proxy surface | `^api/v1/` only; verified end to end |
| Redirects through the proxy | `redirect: 'manual'` — following one would forward the bearer to wherever it points |
| Response headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; `no-store` on every proxied response, asserted end to end |
| Dependency surface | 7 runtime dependencies, all first-party or widely-audited |

---

## 6. Not done, and why

Stated plainly rather than implied by omission.

- **Screen-reader validation.** Automated scanning catches the mechanical
  subset. Semantics were built for it — landmarks, live regions, `aria-current`,
  timecode `aria-valuetext`, native `<dialog>` for focus return — and keyboard
  traversal is tested, but no VoiceOver/NVDA/JAWS pass was performed. This is
  the largest remaining accessibility risk.
- **Core Web Vitals.** Bundle size, poll volume, and preload behaviour are
  asserted; LCP/INP/CLS are not measured. Rule 150 says not to optimize blindly,
  and there is no production traffic to measure against. The E2E suite has a
  bundle-size budget that fails loudly, which is the part that regresses.
- **Real-backend end-to-end.** The E2E suite runs against a stateful API
  stand-in, not against Postgres + Redis + MinIO + a GPU. It enforces the same
  preconditions (casting before TTS, cooperative cancellation,
  supersede-not-overwrite), and the contract test binds every path to the
  specification — but the two have not been run together.
- **Upload against real object storage.** The three-call upload is implemented
  and unit-tested; the `PUT` to a signed URL has not been exercised against a
  real bucket, which additionally requires CORS on the bucket.
- **Notification centre (rule 114).** Not built: no notification endpoint
  exists, and rule 114 conditions it on Phase 8 support. Generation status is
  persistent in the project workspace instead of relying on a toast (rule 113).
- **Archive (rule 120).** Not built: `application-architecture.md` §3 is
  explicit that there is no `ARCHIVED` state and archive is not a concept in
  this API. Soft-deleted projects have their own filter.

---

## 7. Files changed outside `apps/web`

Two, both minimal, neither a behaviour change to Phases 1–8:

| File | Change | Why |
| --- | --- | --- |
| `eslint.config.mjs` | Added `**/.next/**`, `**/playwright-report/**`, `**/test-results/**`, `apps/web/next-env.d.ts` to `ignores`; added `apps/web/postcss.config.mjs` to `allowDefaultProject` | Build output and generated files, same class as the existing `**/dist/**` entry |
| `docker-compose.yml` | Added the `web` service | The deployable `context.md` §22.1 already lists |
| `.env.example` | Documented the four `web` variables | They are new |

New files outside `apps/web`: `infra/docker/web.Dockerfile`,
`docs/application/frontend-architecture.md`,
`docs/application/frontend-api-gaps.md`, and this report.

**`apps/web` is lint-clean** — zero errors, zero warnings. The repository lint
run still reports 34 pre-existing errors, all in
`apps/api/src/assembly/assembly.service.ts`, `apps/worker-cpu/src/processors/*`,
and `tests/integration/assembly.integration.test.ts`. None of those files was
touched by this phase (`git status` confirms), and none was fixed here: they are
Phase 6/7 code, and changing them to make a lint run green would be an
unrequested edit to a completed phase.

---

## 8. How to run it

```bash
pnpm install

# Development — needs the API on :3000 and AUTH_JWT_* configured.
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @audio-book/web dev            # http://localhost:3001

# The whole stack
docker compose up web                        # brings up api, postgres, redis, minio

# Verification
pnpm --filter @audio-book/web typecheck
pnpm --filter @audio-book/web test           # 223 tests
pnpm --filter @audio-book/web build          # production build
pnpm --filter @audio-book/web test:e2e       # 139 executions, 4 engines
pnpm lint
```

Signing in needs a token from the deployment's identity provider — this
application issues none (GAP-1).

---

## 9. Readiness gate

| Area | Verdict |
| --- | --- |
| Core workflow | **READY** |
| Architectural boundary | **READY** |
| Error and failure handling | **READY** |
| Progress honesty | **READY** |
| Security | **READY** |
| Accessibility | **READY WITH CONDITIONS** — no screen-reader pass |
| Performance | **READY WITH CONDITIONS** — no field vitals |
| Casting workflow | **READY WITH CONDITIONS** — voice preview is impossible until GAP-7 is implemented |
| Integration with the real stack | **NOT VERIFIED** — the E2E suite has not been run against the live backend |

The single highest-value follow-up is **GAP-7**: implementing the already-
specified preview `access-urls` route turns casting from "choose by name" into
"choose by ear", which is the difference between a workflow that works and one
a producer would trust.
