/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * PATCH /api/v1/users/me — api-specification.md §16.2. `email` and `roles` are deliberately absent: an email change is an auth-domain operation and roles are administrative.
 */
export interface UpdateCurrentUser {
  display_name?: string;
  preferences?: {
    locale?: string;
    notification_email?: boolean;
  };
}
