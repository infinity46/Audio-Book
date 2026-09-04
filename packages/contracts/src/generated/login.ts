/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/login — api-specification.md §16.1.
 */
export interface Login {
  email: string;
  password: string;
  client_type: 'BROWSER' | 'API';
}
