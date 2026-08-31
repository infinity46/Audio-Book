import { ValidationError } from '@audio-book/errors';

/**
 * Opaque cursor pagination (api-specification.md §10): `{ data, page: { limit,
 * next_cursor, prev_cursor, has_more, total } }`. No list endpoint before
 * Phase 3 needed more than a flat `take` (see books.service.ts), so this is
 * the first cursor implementation — kept intentionally minimal: a cursor is
 * just the last row's `(sortValue, id)` pair, base64-encoded, tie-broken by
 * `id` so pagination stays stable when many rows share a sort value.
 */
export interface CursorPage<T> {
  data: T[];
  page: {
    limit: number;
    next_cursor: string | null;
    has_more: boolean;
  };
}

interface CursorPayload {
  v: string | number;
  id: string;
}

export function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'id' in decoded &&
      'v' in decoded &&
      typeof (decoded as CursorPayload).id === 'string'
    ) {
      return decoded as CursorPayload;
    }
    throw new Error('malformed cursor');
  } catch {
    throw new ValidationError({
      code: 'INVALID_CURSOR',
      message: 'The cursor query parameter is not valid.',
      details: [{ field: 'cursor', issue: 'invalid' }],
    });
  }
}

export function encodeCursor(value: string | number, id: string): string {
  const payload: CursorPayload = { v: value, id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new ValidationError({
      code: 'VALIDATION_FAILED',
      message: `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
      details: [{ field: 'limit', issue: 'out_of_range' }],
    });
  }
  return value;
}

/**
 * Slices `limit + 1` fetched rows into a page: the extra row (if present)
 * proves `has_more` without a separate COUNT query, and its own sort key
 * becomes `next_cursor`.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => string | number,
  idOf: (row: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page,
    page: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor(sortValueOf(last), idOf(last)) : null,
    },
  };
}
