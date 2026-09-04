/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/admin/jobs/{jobId}/replay — api-specification.md §16.22. Replay creates a NEW job carrying the original's lineage; it never mutates the original.
 */
export interface ReplayJob {
  reason?: string;
}
