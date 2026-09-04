# Identity and Account Architecture — Phase 10

> **Status:** Phase 10. Describes what is implemented, not what is planned.
> Where something is specified but unbuilt, this document says so and names
> the finding rather than describing it as if it existed.

---

## 1. What this phase adds, and what it deliberately does not touch

Phase 8 built `JwtAuthGuard` (`apps/api/src/common/guards/jwt-auth.guard.ts`):
a verification-only boundary that checks a bearer RS256 JWT against a JWKS URL
or static public key and populates `{sub, tenant_id, roles, scopes}` onto the
request. Every guard, service, and controller in this codebase authorizes off
that shape. Phase 10 did not change it — the same verification code runs
today as before this phase, unmodified, and every previously-working
authenticated route keeps working exactly as it did.

What Phase 10 adds is the **issuance** half that was missing (Phase 8 finding
P8-8): `apps/api/src/auth/` (`AuthService`, `TokenService`, `AuthController`)
implements `api-specification.md` §16.1's `/api/v1/auth/**` endpoints, and
`apps/api/src/users/users.service.ts` gained `GET`/`DELETE
/users/me/sessions` (§16.2) now that `Session`/`RefreshToken` have a writer.
Every table this touches (`user`, `user_credential`, `user_identity`,
`session`, `refresh_token`) already existed in the schema from `0001_init` —
Phase 8 verified tokens issued by *something*, but nothing in this codebase
was that something. Phase 10 is that something.

```
   registration/login/refresh/logout        every other request
              │                                      │
              ▼                                      ▼
   ┌─────────────────────┐              ┌─────────────────────────┐
   │   AuthService /      │  signs w/    │      JwtAuthGuard        │
   │   TokenService        │──private──▶ │  (unchanged since Ph.8) │
   │   (issuance)          │   key       │  verifies w/ public key  │
   └─────────────────────┘              │  or JWKS                 │
                                          └─────────────────────────┘
```

## 2. Token issuance vs. verification

`TokenService.issueAccessToken` signs with `AUTH_JWT_PRIVATE_KEY` (PKCS8 PEM,
new in Phase 10) — the operator is responsible for making this the private
half of whatever `AUTH_JWT_PUBLIC_KEY`/`AUTH_JWT_JWKS_URL` `JwtAuthGuard`
verifies against. A deployment that only ever verifies externally-issued
tokens and never mints its own can leave `AUTH_JWT_PRIVATE_KEY` unset; any
`/auth/**` call that would issue a token then fails closed with
`AUTH_ISSUANCE_NOT_CONFIGURED` rather than starting insecurely or signing
with a missing key.

Access token claims: `{sub, tenant_id, roles, scopes, sid, jti, iat, exp,
iss, aud}` — the `context.md` §18.1 set, plus one Phase 10 addition: `sid`
(the session id). `JwtAuthGuard` reads only `sub`/`tenant_id`/`roles`/
`scopes` and ignores unknown claims, so `sid` is fully additive. It exists so
`POST /auth/logout` can revoke the *exact* session a token belongs to without
threading a new field through `AuthenticatedPrincipal` (which every other
guard and controller also constructs from `JwtAuthGuard`) — the controller
decodes it directly from the already-verified bearer token
(`decodeSessionId`, `apps/api/src/auth/token.service.ts`), a plain
non-verifying decode since the signature was already checked earlier in the
guard chain for the same request.

## 3. Endpoints implemented (`api-specification.md` §16.1)

| Endpoint | Behavior |
| --- | --- |
| `POST /auth/register` | Creates `Tenant` + `User` (`TENANT_OWNER`) + `UserCredential` (Argon2id) in one transaction. Enumeration protection (default on, `AUTH_ENUMERATION_PROTECTION`): a duplicate email returns the identical `201 REGISTRATION_PENDING` shape a new registration does, doing the same amount of work (hashing the submitted password) so timing does not distinguish the two cases either. With protection off, a duplicate is `409 EMAIL_ALREADY_REGISTERED`. |
| `POST /auth/login` | Verifies the password (constant-time-ish: an unknown email still runs a dummy Argon2 verify, §14.11), creates a `Session` + `RefreshToken` family, issues an access token. Progressive lockout: `AUTH_LOGIN_MAX_FAILED_ATTEMPTS` consecutive failures locks the account for `AUTH_LOGIN_LOCKOUT_SECONDS` (`429 ACCOUNT_LOCKED`), tracked on `UserCredential.failedAttemptCount`/`lockedUntil`. |
| `POST /auth/mfa` | Exchanges an `mfa_token` for tokens. **Unreachable in this deployment today** — see §4. |
| `POST /auth/refresh` | Rotates the refresh token: the presented token is marked `rotatedAt`/`rotatedToId`, a new one is issued in the same family. **Reuse detection**: presenting an already-rotated token revokes the whole family (every `RefreshToken` and the `Session` itself) and writes `REFRESH_TOKEN_REUSE_DETECTED` to the audit log — the protocol cannot distinguish "client retried a stale response" from "a stolen token was used after the legitimate client already moved on," so it treats every reuse as the dangerous case. |
| `POST /auth/logout` | Revokes the session named by the bearer token's `sid` claim and every `RefreshToken` in it. Naturally idempotent — a missing or already-revoked session is a silent no-op, still `204`. |
| `POST /auth/password-reset` | Always `202`, regardless of whether the email exists. Generates an opaque token, stores only its SHA-256 in Redis (`pwreset:<hash>`, 30-minute TTL) against the user id. |
| `POST /auth/password-reset/confirm` | Verifies the token, updates the password, revokes **every** session and refresh token for the principal, deletes the Redis entry (single-use). |

## 4. MFA is real code, reachable by nothing

`api-specification.md` §16.1's note (OQ-6) is explicit: factor *enrollment*
endpoints are reserved and **must not be invented**. This codebase honors
that — there is no `POST /auth/mfa/enroll` anywhere, and nothing ever sets
`UserCredential.mfaEnrolled` to `true`. Consequently `login()`'s
`MFA_REQUIRED` branch and `POST /auth/mfa` itself are unreachable in this
deployment: no login can ever produce an `mfa_token` for `/auth/mfa` to
consume.

Both are still implemented for real rather than stubbed — `apps/api/src/
auth/totp.ts` is a genuine RFC 6238 TOTP verifier (SHA-1, 6 digits, 30s step,
±1 step window), tested against real HOTP-derived codes
(`totp.test.ts`) — so the wire contract is correct and ready the moment a
later phase adds enrollment, rather than being a plausible-looking fake that
would need rewriting.

## 5. Browser vs. API clients, and why `JwtAuthGuard` needed no cookie support

§16.1's `client_type: "BROWSER"` response sets a `session` cookie (httpOnly,
carries the *refresh* token) and a `csrf` cookie (JS-readable, double-submit
companion required as an `X-CSRF-Token` header on any cookie-authenticated
`/auth/refresh` or `/auth/logout` call), and explicitly returns **no tokens
in the body**.

This does not require teaching `JwtAuthGuard` to read cookies. The resolved
flow: a browser client logs in (cookie set), immediately calls `/auth/refresh`
(cookie-authenticated, CSRF-checked) to obtain a short-lived access token in
the response body, and holds that token in memory for the lifetime of the
page — attaching it as `Authorization: Bearer` exactly like an API client for
every other request. Only the long-lived refresh token ever touches a
cookie; `JwtAuthGuard` stays Bearer-only, unmodified, and every existing
route's authorization behavior is unaffected by any of this.

`apps/api/src/auth/cookies.ts` implements cookie set/parse/clear manually
(`Set-Cookie`/`Cookie` header strings) rather than adding a Fastify cookie
plugin dependency for two cookie names.

## 6. `user.registered` and `auth.password_reset_requested` — a documented event-contract gap

`context.md` §3.2.2 names `user.registered` as an Auth Service output, but
`event-contracts.md`'s closed 36-event catalogue does not enumerate it (or
any auth-domain event) — a genuine, narrow inconsistency between the two
frozen documents, not something Phase 10 invented. `AuthService.register`
and `.requestPasswordReset` still write these events to the outbox, using the
exact established envelope and `noun.verb` naming convention every other
event uses (`writeOutboxMessage`), because `context.md` is unambiguous that
the event should exist and the outbox mechanism has no closed-set enforcement
on `event_type` (unlike, say, `AuditAction`, which is a real Postgres enum).
**Recommendation:** `event-contracts.md` should be amended to formally list
these two event types in a future documentation pass.

Email delivery itself is out of reach: no Notification Service integration
exists anywhere in this codebase. The outbox events are written durably and
correctly but have no consumer yet — `OutboxPublisher` already logs
"durably published, no downstream broadcast consumer yet" for every domain
event in exactly this situation, which is what happens here too. In this
deployment, a user cannot yet receive a password-reset email through the
product. This is a known, honest limitation — see
`docs/qa/phase-10-quality-report.md`.

## 7. Ownership and authorization — unchanged from Phase 8, extended by one role check

Every book/project/artifact ownership rule Phase 8 established
(`assertTenantOwnership`, cross-tenant access is `404` never `403`,
`TenantRoleGuard`'s tenant-membership check, `PlatformAdminGuard`'s absolute
content boundary) is untouched by Phase 10. One addition: `requireRole`
(`apps/api/src/common/tenant.ts`) checks a role *within* a tenant the caller
already owns — used by book restoration and purge
(`api-specification.md` §16.6.2/§16.6.3), which are `TENANT_OWNER`-only even
for another member of the same tenant. This is a `403`, not a `404`: the
resource's existence is already established by the ownership check that runs
first.

## 8. What Phase 10 identity work does *not* include

- No OAuth/OIDC provider integration. `UserIdentity.provider` supports
  `OIDC` in the schema; nothing in this phase populates a non-`LOCAL` row.
- No MFA enrollment (§4).
- No admin-side user management beyond what Phase 8's `/admin/users` already
  read-only exposed.
- No change to `PLATFORM_ADMIN`'s content boundary or to how admin routes
  authorize — Phase 10 added no admin-facing identity surface.
