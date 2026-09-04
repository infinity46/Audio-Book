/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/jobs/{jobId}/cancellation — api-specification.md §16.18. Cancellation is cooperative and idempotent; the body carries only an optional human reason recorded on the audit trail.
 */
export interface CancelJob {
  reason?: string;
}
