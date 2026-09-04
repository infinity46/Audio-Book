-- Phase 10 — identity, ownership, quota, storage lifecycle.
--
-- WHY THIS EXISTS
--
-- Every table Phase 10's auth/session/quota work needs (`user`,
-- `user_credential`, `user_identity`, `session`, `refresh_token`,
-- `tenant_quota`, `tenant_usage_counter`) was already created by 0001_init —
-- Phase 8 verified externally-issued tokens against these tables but never
-- wrote to them. This migration adds only the two `audit_action` enum
-- members Phase 10's new auth endpoints need to satisfy
-- `api-specification.md` §16.1's "audit record written" requirements, for
-- which no existing action fits without overloading its meaning:
--
--   - USER_REGISTERED  — POST /auth/register
--   - LOGIN_SUCCEEDED  — POST /auth/login
--
-- `BOOK_RESTORED`, `BOOK_PURGED`, `SESSION_REVOKED`, and
-- `REFRESH_TOKEN_REUSE_DETECTED` already exist in `audit_action` (0001_init)
-- and are reused as-is by the restoration/purge/session-revocation/
-- refresh-rotation work in this phase — no enum change needed for those.
--
-- ADD VALUE cannot run inside the same transaction as a later statement that
-- uses it, but a bare ALTER TYPE is safe on its own and Prisma applies each
-- migration file in one transaction — this file contains nothing else, so
-- there is no ordering hazard.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'USER_REGISTERED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'LOGIN_SUCCEEDED';
