import { describe, expect, it } from 'vitest';
import { runIngestionPipeline } from './pipeline.js';
import { buildCrossPageHyphenatedPdf, buildGoldenBookPdf } from './test-fixtures/build-fixtures.js';
import { GOLDEN_BOOK_EXPECTED } from './test-fixtures/golden-book.expected.js';

/**
 * Phase 7 text-fidelity gate (§10-§13): one golden book fixture carried
 * through the real ingestion pipeline and compared against hand-written
 * expected results. Unlike pipeline.test.ts — which exercises one property
 * per narrow fixture — this asserts that ALL of them hold simultaneously on
 * a single document, which is where interactions between noise removal,
 * dehyphenation, and structure detection actually surface.
 *
 * The gate is deliberately strict about counts, not just presence: a phrase
 * appearing twice is as much a fidelity failure as one that vanished.
 */
describe('Golden book: source document -> canonical text fidelity', () => {
  async function ingestGoldenBook() {
    const buffer = await buildGoldenBookPdf();
    return runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });
  }

  function canonicalText(result: Awaited<ReturnType<typeof ingestGoldenBook>>): string {
    return result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ');
  }

  it('preserves the chapter structure', async () => {
    const result = await ingestGoldenBook();
    expect(result.chapters.map((c) => c.title)).toEqual([...GOLDEN_BOOK_EXPECTED.chapterTitles]);
    expect(result.qualityReport.outcome).toBe('PASS');
  });

  it('carries every phrase through exactly once — no loss, no duplication, no corruption', async () => {
    const text = canonicalText(await ingestGoldenBook());
    for (const phrase of GOLDEN_BOOK_EXPECTED.mustAppearExactlyOnce) {
      expect(occurrences(text, phrase), `expected exactly one occurrence of: ${phrase}`).toBe(1);
    }
  });

  it('strips OCR-style page noise instead of narrating it', async () => {
    const result = await ingestGoldenBook();
    const text = canonicalText(result);
    for (const phrase of GOLDEN_BOOK_EXPECTED.mustNotAppear) {
      expect(text, `expected NOT to find: ${phrase}`).not.toContain(phrase);
    }
    // A bare page-number footer must never become a paragraph of its own.
    for (const chapter of result.chapters) {
      for (const paragraph of chapter.paragraphs) {
        expect(paragraph.text.trim()).not.toMatch(/^\d{1,4}$/);
      }
    }
  });

  it('rejoins a hyphenation broken across a page boundary', async () => {
    // Was a KNOWN GAP recorded with `it.fails`: dehyphenation runs within a
    // single block, so a word split by a page break stayed split across two
    // paragraphs with a dangling hyphen ("…an extra-" / "ordinary afternoon…"),
    // which TTS would narrate as a broken word. detect-structure now merges the
    // two blocks on the same conservative evidence dehyphenate uses. Fixing it
    // changes canonical text, so `normalizationVersion` moved to normalize.v2.
    const buffer = await buildCrossPageHyphenatedPdf();
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });
    const paragraphs = result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text));
    expect(paragraphs.join(' ')).toContain('extraordinary');
    // The word must live in ONE paragraph, not be split across two.
    expect(paragraphs.some((p) => p.includes('extraordinary'))).toBe(true);
    expect(paragraphs.some((p) => p.endsWith('-'))).toBe(false);
  });

  it('is reproducible: the same bytes and config produce the same content hash', async () => {
    const buffer = await buildGoldenBookPdf();
    const [first, second] = await Promise.all([
      runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' }),
      runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' }),
    ]);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.rawTextContentHash).toBe(second.rawTextContentHash);
  });
});

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
