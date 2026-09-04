/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/auth/register — api-specification.md §16.1.
 */
export interface Register {
  email: string;
  password: string;
  display_name?: string | null;
}
