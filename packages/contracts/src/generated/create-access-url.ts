/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateAccessUrl {
  disposition?: 'INLINE' | 'ATTACHMENT';
  format?: string;
  expires_in_seconds?: number;
}
