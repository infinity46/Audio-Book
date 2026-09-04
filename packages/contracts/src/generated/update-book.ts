/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

/**
 * PATCH /api/v1/books/{bookId} — api-specification.md §16.5. User-editable metadata only; `status` is deliberately absent because pipeline state is never patchable.
 */
export interface UpdateBook {
  title?: string;
  author?: string | null;
  language?: string;
  description?: string | null;
  metadata?: {
    series?: string | null;
    series_index?: number | null;
    publication_year?: number | null;
    publisher?: string | null;
  };
}
