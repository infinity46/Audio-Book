/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * PATCH /api/v1/admin/tenants/{tenantId}/quotas — api-specification.md §16.22. PLATFORM_ADMIN only, audited.
 */
export interface UpdateTenantQuotas {
  concurrent_books?: number;
  gpu_minutes_monthly?: number;
  storage_bytes?: number;
  books_total?: number;
}
