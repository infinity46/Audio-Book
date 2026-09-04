/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * POST /api/v1/books/{bookId}/purge — api-specification.md §16.6.3. `confirm_book_id` must equal the path parameter.
 */
export interface PurgeBook {
  confirm_book_id: string;
}
