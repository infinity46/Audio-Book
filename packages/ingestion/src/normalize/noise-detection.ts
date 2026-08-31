/**
 * Repeated header/footer and page-number detection (task §36-§38): uses
 * cross-page repetition as evidence, never removes on a single occurrence,
 * and never removes without recording what it removed (for the quality
 * report / review flags, task §65).
 */

export interface PageLevelBlock {
  pageNumber: number;
  /** Position of this block among all blocks on its page (0 = first, negative counts from the end e.g. -1 = last). */
  positionOnPage: 'first' | 'last' | 'other';
  text: string;
}

export interface NoiseDetectionResult {
  /** Normalized text of lines classified as header/footer noise. */
  removedTexts: Set<string>;
  pageNumberPattern: boolean;
}

const PAGE_NUMBER_PATTERN = /^(page\s+)?\d{1,4}$/i;
const ROMAN_NUMERAL_PATTERN = /^[ivxlcdm]{1,8}$/i;

/**
 * `blocks` should be the first and last block of every page (task §37/§38's
 * "same short line at the same relative position on N% of pages").
 */
export function detectNoise(
  blocks: PageLevelBlock[],
  confidenceThreshold: number,
): NoiseDetectionResult {
  const totalPages = new Set(blocks.map((b) => b.pageNumber)).size;
  if (totalPages < 3) {
    // Not enough pages to establish repetition with any confidence.
    return { removedTexts: new Set(), pageNumberPattern: false };
  }

  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.positionOnPage === 'other') continue;
    const key = normalizeForComparison(block.text);
    if (key.length === 0 || key.length > 120) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const removedTexts = new Set<string>();
  let sawPageNumberLikeRepeat = false;

  for (const [key, count] of counts) {
    const ratio = count / totalPages;
    if (ratio < confidenceThreshold) continue;

    // A literal repeated string (running header/title/publisher line).
    removedTexts.add(key);

    if (PAGE_NUMBER_PATTERN.test(key) || ROMAN_NUMERAL_PATTERN.test(key)) {
      sawPageNumberLikeRepeat = true;
    }
  }

  // Page numbers vary per page (they're not the *same* string), so they
  // never hit the exact-match repetition counter above. Detect them
  // structurally instead: a short first/last-position line that is purely
  // numeric or roman-numeral on a strong majority of pages, regardless of
  // its specific value.
  const numericPositions = new Map<string, number>(); // 'first' | 'last' -> count of numeric-looking lines
  for (const block of blocks) {
    if (block.positionOnPage === 'other') continue;
    const normalized = normalizeForComparison(block.text);
    if (PAGE_NUMBER_PATTERN.test(normalized) || ROMAN_NUMERAL_PATTERN.test(normalized)) {
      numericPositions.set(
        block.positionOnPage,
        (numericPositions.get(block.positionOnPage) ?? 0) + 1,
      );
    }
  }
  for (const count of numericPositions.values()) {
    if (count / totalPages >= confidenceThreshold) {
      sawPageNumberLikeRepeat = true;
    }
  }

  return { removedTexts, pageNumberPattern: sawPageNumberLikeRepeat };
}

export function isPageNumberLike(text: string): boolean {
  const normalized = normalizeForComparison(text);
  return PAGE_NUMBER_PATTERN.test(normalized) || ROMAN_NUMERAL_PATTERN.test(normalized);
}

function normalizeForComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
