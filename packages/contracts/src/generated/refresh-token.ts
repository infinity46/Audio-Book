/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/refresh — api-specification.md §16.1. `refresh_token` is required for API clients; browsers send an empty body and present the refresh token via the `session` cookie instead.
 */
export interface RefreshToken {
  refresh_token?: string;
}
