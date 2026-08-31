/**
 * Text normalization (task §31-§35): Unicode/whitespace cleanup and
 * conservative dehyphenation only — never semantic rewriting (task §32).
 * Pure function of (text, config); `normalize(normalize(x)) === normalize(x)`
 * is a property test in normalize.test.ts (task §104's idempotence
 * invariant).
 */
import type { IngestionConfig } from '../config.js';

const SOFT_HYPHEN = '­';

export function normalizeText(text: string, config: Pick<IngestionConfig, 'dehyphenate'>): string {
  let result = text;

  // Unicode normalization (task §35) — canonical composition, no
  // transliteration of curly quotes/dashes/ellipses (task §35/§48).
  result = result.normalize('NFC');

  // Drop soft hyphens outright (invisible formatting artifacts, not content).
  result = result.replaceAll(SOFT_HYPHEN, '');

  // Line-break/whitespace normalization (task §34), preserving paragraph
  // boundaries: collapse runs of spaces/tabs, but leave blank-line breaks
  // (paragraph boundaries) alone — this function operates on already
  // paragraph-segmented text, so within a call there should be no
  // paragraph boundary to preserve; multiple internal newlines still
  // collapse to a single space since a paragraph's own text is one unit.
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\n+/g, config.dehyphenate ? '\n' : ' ');

  if (config.dehyphenate) {
    result = dehyphenate(result);
    result = result.replace(/\n/g, ' ');
  }

  result = result.replace(/ +/g, ' ').trim();

  return result;
}

const LOWERCASE_WORD = /[a-z]/;

/**
 * Joins `word-\nword` line-break hyphenation only when both fragments look
 * like a continued lowercase word (task §33: conservative — never destroy
 * a legitimate hyphenated compound like "well-\nknown" mid-sentence vs a
 * genuine compound at a non-line-break hyphen, which this never touches
 * since it only matches a hyphen immediately followed by a newline).
 */
function dehyphenate(text: string): string {
  return text.replace(/(\p{L}+)-\n(\p{L}+)/gu, (match, before: string, after: string) => {
    const lastCharBefore = before.charAt(before.length - 1);
    const firstCharAfter = after.charAt(0);
    const looksLikeContinuation =
      LOWERCASE_WORD.test(lastCharBefore) && LOWERCASE_WORD.test(firstCharAfter);
    return looksLikeContinuation ? `${before}${after}` : `${before}-${after}`;
  });
}
