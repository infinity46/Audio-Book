# Frontend ↔ API gaps

> Phase 9 rule 162: where the frontend requires a capability the API does not
> have, **stop and report** — the required capability, the gap, the reason, and
> a proposed contract change. Rule 163: build no hidden workaround.
>
> This document is that report. Nothing below was worked around silently: each
> gap has a visible consequence in the studio, and this file is what the
> studio's own copy points at. No Phase 1–8 code was modified to close any of
> them (rule 162).

**Nothing here is a defect in Phase 8.** Every item is either explicitly
reserved by `api-specification.md`, explicitly deferred by the Phase 8 report,
or a read path the specification simply never defined. They are listed because
a frontend is the first consumer that actually needs them.

---

## Summary

| Id | Capability the studio needs | Status | Blocks a Phase 9 rule | Severity |
| --- | --- | --- | --- | --- |
| GAP-1 | A way to obtain a token | **Resolved in Phase 10** — see below | 73 | Was Medium; closed |
| GAP-2 | `include=stages` on `GET /books` | Not specified | 8 | Low — cards show status, not fabricated progress |
| GAP-3 | A **read** path for cover art | Not specified | 69 | Medium — no cover can be displayed at all |
| GAP-4 | Character name search / sort | Not specified | 26, 27 | Low — done over the fully-fetched cast, and labelled |
| GAP-5 | Bulk voice-assignment read | Not specified | 24, 30 | Low — derived from `casting.blocking` instead |
| GAP-6 | Book search / sort | Not specified | 115, 117 | Medium — controls are absent rather than faked |
| GAP-7 | Voice **preview** byte access | Specified, **not implemented** | 29, 31, 136 | High — preview playback is impossible |
| GAP-8 | Review item lifecycle | Reserved, not specified (OQ-3) | 55, 56 | Medium — approve/reject states are not shown |

---

## GAP-1 — There is no way to obtain a credential — **RESOLVED in Phase 10**

**What the studio needed.** A user has to sign in.

**What existed through Phase 9.** Nothing. `api-specification.md` §16.1 defines
`/api/v1/auth/**` and §16.2 defines `/users/me/sessions`, and Phase 8 finding
**P8-8** recorded both as not implemented: that deployment *verified* an
externally-issued RS256 bearer token and implemented no registration, login,
refresh, or MFA. The `session` and `refresh_token` tables had no writer.

**What Phase 10 implemented.** `/api/v1/auth/register`, `/login`, `/mfa`,
`/refresh`, `/logout`, `/password-reset`, `/password-reset/confirm` exactly as
§16.1 specifies (see `apps/api/src/auth/`), and `/users/me/sessions` (list +
revoke, `apps/api/src/users/users.service.ts`). `JwtAuthGuard` — the
verification path every other route already depended on — was **not
modified**; the new `TokenService` only adds the matching issuance half, so no
previously-working route changed behavior. See
`docs/application/identity-and-account-architecture.md` for the full design
and `docs/qa/phase-10-quality-report.md` for what was tested.

**Consequence for the studio.** The Phase 10 frontend pass replaces the
sign-in page's raw-token paste with a real email/password form, per
`docs/application/frontend-api-gaps.md`'s own rule 162/163 discipline: this
closes the gap by implementing the missing capability, not by inventing a
frontend-side workaround.

---

## GAP-2 — `GET /books` cannot embed stage progress

**What the studio needs.** Rule 8 asks a project card to show progress,
chapter count, and duration.

**What exists.** `?include=stages` is defined on `GET /books/{id}` only
(§16.5), and `books.service.ts` `listBooks` accepts `status`, `cursor`,
`limit`, and `include_deleted` — nothing else. The collection returns the plain
`Book` resource, which carries no progress, no chapter count, and no duration.

**Why no workaround.** One progress request per card would be 24 extra requests
per page against a `read` bucket limited per user *and* per tenant. Rule 88
forbids that class of amplification, and inventing a progress figure is rule 17.

**Visible consequence.** Cards in the library grid show status, next action, and
last-updated. Progress bars appear only in the dashboard's "In production"
section, where the set is small (≤5) and per-project progress is fetched for
real.

**Proposed contract change.** Accept `include=stages` on `GET /books` too, with
the existing `MAX_PAGE_LIMIT` cap. `ProgressService.getStageSummary` already
produces the payload; batching it over a page of ids is a query change, not a
contract change to the shape.

---

## GAP-3 — Cover art is write-only

**What the studio needs.** Rule 69: display canonical cover art using
backend-provided URLs.

**What exists.** `PUT /books/{id}/audiobooks/{id}/cover` — a write. There is no
`GET`, no `access-urls` sub-resource for the cover, and the `audiobook` resource
reports only `cover: { present, width, height, content_hash }`. §15.12 lists no
read route. So there is **no URL to render**, from any endpoint.

**Visible consequence.** Every project shows a deterministic monogram derived
from its own id. `CoverArt.tsx` states plainly that it is a placeholder and is
never presented as the book's artwork (rules 161, 174).

**Proposed contract change.** Add
`POST /api/v1/books/{bookId}/audiobooks/{audiobookId}/cover/access-urls`,
identical in shape to every other §16.20 minting route. That is additive and
needs no new entity.

---

## GAP-4 — Characters cannot be searched or sorted server-side

**What the studio needs.** Rules 26 and 27: search and sort a large cast.

**What exists.** `analysis.service.ts` `listCharacters` accepts `status`,
`speaking`, and `include_sentinels`, and orders by `importance_rank` with no
`sort` parameter.

**Why the client-side approach is honest here.** The set is **complete and
bounded**: one book's cast, every page walked to the end, tens to low hundreds
of rows. That is materially different from the tenant-wide book list (GAP-6),
where the same approach would be unbounded. The UI says "Filtering and sorting
apply to the loaded cast", and the list is windowed so 200+ rows stay
responsive.

**Proposed contract change.** Add `q` (prefix match on `display_name`, which the
existing index supports) and a `sort` allowlist of `importance_rank`,
`display_name`, `line_count` — the same allowlist pattern `GET /jobs` already
uses.

---

## GAP-5 — There is no bulk read of voice assignments

**What the studio needs.** The cast list shows each character's casting state.

**What exists.** `GET /books/{id}/characters/{characterId}/voice`, one character
at a time. A 200-character cast would be 200 requests.

**Why no workaround.** It is not needed: `GET /books/{id}/casting` already
returns every *blocking* character with a reason and the speaking-character
count, so a speaking character absent from `blocking` is — by that endpoint's
own construction — assigned and approved. `src/lib/casting.ts` derives the whole
cast's status from that one request, and says so.

What it cannot derive is *which* voice. The studio fetches that lazily, for the
character the user actually opens.

**Proposed contract change.** Either return `voice_profile_id` /
`voice_profile_version` on the character resource, or add
`GET /books/{id}/voice-assignments` as a normal paginated collection.

---

## GAP-6 — Books cannot be searched or sorted

**What the studio needs.** Rules 115 and 117: search by title/author/status,
and sort by recently-updated, created, or alphabetical.

**What exists.** `GET /books` filters on `status` only, and orders by
`created_at desc` with no `sort` parameter.

**Why nothing was faked.** Fetching every page of a tenant-wide collection to
filter in the browser is unbounded, and rule 163 forbids exactly that kind of
hidden workaround. Rule 161 forbids rendering a search box that does not search.

**Visible consequence.** The library offers status filters, which are real, and
**no search box and no sort control**, which would not be.

**Proposed contract change.** Add `q` and a `sort` allowlist
(`created_at`, `updated_at`, `title`) to `GET /books`, matching `GET /jobs`.
`title` needs an index; `updated_at` already has one.

---

## GAP-7 — Voice preview audio cannot be played (blocking)

**What the studio needs.** Rules 29, 31, and 136: hear a voice before casting a
character to it. This is the single most valuable missing capability for the
casting workflow.

**What exists — and what does not.**
`POST /voice-profiles/{id}/versions/{v}/previews` is implemented and produces a
`VoicePreview`. `GET .../previews` and `GET .../previews/{id}` are implemented.
But `api-specification.md` §15.13 line 1529 specifies

```
POST /api/v1/voice-profiles/{id}/versions/{version}/previews/{previewId}/access-urls
```

and `voice.controller.ts` **does not implement it**. There is therefore no way
to obtain the preview's bytes: the resource reports `duration_ms`,
`sample_rate`, and `capability_gap`, but never a URL.

**Visible consequence.** The voice picker renders **no play control anywhere** —
a Play button would be a dead control (rule 160) for a capability that does not
exist (rule 161). Instead it states, in the picker itself, that this deployment
cannot return preview audio and why. Voices are chosen by name, provider,
language, and approval state.

The studio also does **not** offer preview *generation*, because producing audio
a user cannot hear is not a feature.

**Proposed contract change.** None — the endpoint is already specified.
Implement §15.13's preview `access-urls` route in `VoiceController`, using the
same `AccessUrlService` path the audio-chunk and chapter-audio routes use. This
is the highest-value item in this document.

---

## GAP-8 — Review has no item lifecycle

**What the studio needs.** Rules 55 and 56: Approve / Reject actions and
Pending / Reviewed / Approved / Rejected states.

**What exists.** No `ReviewItem` entity. `api-specification.md` §15.18 records
review items as **"Reserved, not specified"** (OQ-3), and Phase 8 deliberately
did not invent one. The review surface the contract provides is flagged script
chunks.

**What the studio does instead.** It uses the actions the API genuinely
supports on a chunk, and names them for what they are:

| Studio action | API call | Not called |
| --- | --- | --- |
| Correct this passage | `PATCH .../audio-script-chunks/{id}` — `performance.speaker_type` / `character_id` / `emotion` / `delivery_mode` | — |
| Mark as resolved | `PATCH .../audio-script-chunks/{id}` — `quality.review_flags: []` | "Approve" |
| Regenerate audio | `POST .../tts` with `scope: CHUNKS` | "Retry" |

There is no Approve badge, no Reject action, and no severity label — the API
supplies none of the three, and rule 55 forbids inventing them. Rule 172 permits
prioritisation only where the backend supplies severity; `review_flags[]` is a
flat vocabulary, so the queue groups by flag and claims no ranking.

**Proposed contract change.** Specify OQ-3. Minimally: a `review_state` on
`AudioScriptChunk` (`PENDING | REVIEWED | ACCEPTED`) plus `reviewed_by` and
`reviewed_at`, which the existing `PATCH` could set. That gives an auditable
"who decided this" without a new aggregate.

---

## Two related items, already documented, that the studio surfaces honestly

Neither is a new gap; both shape what the studio can truthfully display.

- **F-26 / P8-6 — no worker or attempt records.** `GET /jobs/{id}/attempts` and
  `GET /admin/workers` return empty because nothing registers. The studio does
  not render an attempts view, because an always-empty screen is worse than no
  screen. `/capabilities` consequently reports `degraded: true` with
  `available: null` per provider, and the generation settings screen says so
  rather than claiming an engine is online.

- **F-16 — `book.current_audiobook_id` is never written.** The studio never
  reads it; it follows `GET .../audiobook` → `current_audiobook_id`, which is
  the reliable pointer, exactly as `api-usage-guide.md` §11 instructs.
