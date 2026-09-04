/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/mfa — api-specification.md §16.1. Factor enrollment is reserved (OQ-6); this only exchanges an mfa_token issued by a prior /auth/login call.
 */
export interface MfaExchange {
  mfa_token: string;
  code: string;
}
