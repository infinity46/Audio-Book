/**
 * Hand-written expected results for `buildGoldenBookPdf` — the text-fidelity
 * gate's ground truth (Phase 7 §11/§12/§13). Any change to a value here is a
 * deliberate, reviewable statement that the pipeline's canonical output has
 * legitimately changed; it must never be edited just to make a failing test
 * pass.
 */
export const GOLDEN_BOOK_EXPECTED = {
  chapterTitles: ['Chapter 1', 'Chapter 2'],

  /**
   * Every phrase must survive ingestion intact and appear EXACTLY ONCE in the
   * canonical text — this is what catches dropped, duplicated, or corrupted
   * words, names, numbers, dates, punctuation, and non-English characters.
   */
  mustAppearExactlyOnce: [
    '47 ships',
    'the 3rd of May, 1926',
    '42 years old',
    'C’est la vie',
    '“Wait,” Alice said, “didn’t Bob tell you, ‘never go back,’ only yesterday?”',
    '“He did,” Bob answered quietly.',
    'extraordinary season', // the page-1 line-break hyphenation, rejoined
  ],

  /** OCR-style noise that must never reach the canonical text as narratable prose. */
  mustNotAppear: [
    'THE GREAT BOOK', // header repeated on every page
    'extra-\nordinary', // hyphenation must be rejoined, never carried through raw
    'extra- ordinary',
  ],
} as const;
