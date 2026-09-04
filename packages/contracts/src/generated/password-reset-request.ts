/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/password-reset — api-specification.md §16.1. Always 202, regardless of whether the address exists (§14.11 enumeration protection).
 */
export interface PasswordResetRequest {
  email: string;
}
