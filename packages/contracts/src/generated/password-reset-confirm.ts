/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/password-reset/confirm — api-specification.md §16.1.
 */
export interface PasswordResetConfirm {
  reset_token: string;
  new_password: string;
}
