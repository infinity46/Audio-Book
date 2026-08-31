import { describe, expect, it } from 'vitest';
import { buildQualityReport } from './quality-report.js';
import type { CanonicalChapter, CanonicalParagraph } from './structure/detect-structure.js';
import type { ExtractedPage } from './model.js';

function paragraph(text: string, overrides: Partial<CanonicalParagraph> = {}): CanonicalParagraph {
  return {
    orderIndex: 0,
    spinePosition: 0,
    text,
    rawText: text,
    sourceLocator: { kind: 'pdf', page: 1, blockIndex: 0 },
    extractionMethod: 'DIGITAL_TEXT',
    ...overrides,
  };
}

function chapter(overrides: Partial<CanonicalChapter> = {}): CanonicalChapter {
  return {
    orderIndex: 0,
    spineStart: 0,
    spineEnd: 0,
    matterType: 'BODY',
    sections: [],
    paragraphs: [],
    ...overrides,
  };
}

describe('buildQualityReport', () => {
  it('passes for well-formed content with no anomalies', () => {
    const chapters = [chapter({ paragraphs: [paragraph('a'.repeat(100))] })];
    const report = buildQualityReport(chapters, 100, 95, undefined);
    expect(report.outcome).toBe('PASS');
  });

  it('flags NEEDS_REVIEW for a chapter with zero paragraphs', () => {
    const chapters = [
      chapter({ orderIndex: 0, paragraphs: [paragraph('a'.repeat(50))] }),
      chapter({ orderIndex: 1, paragraphs: [] }),
    ];
    const report = buildQualityReport(chapters, 50, 50, undefined);
    const emptyCheck = report.checks.find((c) => c.check === 'empty_chapters')!;
    expect(emptyCheck.outcome).toBe('NEEDS_REVIEW');
    expect(emptyCheck.affected_chapter_ids).toEqual([1]);
    expect(report.outcome).toBe('NEEDS_REVIEW');
  });

  it('flags NEEDS_REVIEW for severe content loss', () => {
    const chapters = [chapter({ paragraphs: [paragraph('a'.repeat(30))] })];
    const report = buildQualityReport(chapters, 1000, 30, undefined);
    const lossCheck = report.checks.find((c) => c.check === 'content_loss_ratio')!;
    expect(lossCheck.outcome).toBe('NEEDS_REVIEW');
  });

  it('flags WARN for duplicate long paragraphs across chapters', () => {
    const duplicateText = 'x'.repeat(80);
    const chapters = [
      chapter({ orderIndex: 0, paragraphs: [paragraph(duplicateText)] }),
      chapter({ orderIndex: 1, paragraphs: [paragraph(duplicateText)] }),
    ];
    const report = buildQualityReport(chapters, 160, 160, undefined);
    const dupCheck = report.checks.find((c) => c.check === 'duplicate_paragraphs')!;
    expect(dupCheck.outcome).toBe('WARN');
    expect(dupCheck.affected_chapter_ids).toEqual([0, 1]);
  });

  it('does not flag short repeated lines as duplicates', () => {
    const chapters = [
      chapter({ orderIndex: 0, paragraphs: [paragraph('Yes.')] }),
      chapter({ orderIndex: 1, paragraphs: [paragraph('Yes.')] }),
    ];
    const report = buildQualityReport(chapters, 8, 8, undefined);
    const dupCheck = report.checks.find((c) => c.check === 'duplicate_paragraphs')!;
    expect(dupCheck.outcome).toBe('PASS');
  });

  it('flags missing pages as NEEDS_REVIEW', () => {
    const pages: ExtractedPage[] = [
      { pageNumber: 1, extractionMethod: 'DIGITAL_TEXT', status: 'OK', charCount: 10 },
      { pageNumber: 3, extractionMethod: 'DIGITAL_TEXT', status: 'OK', charCount: 10 },
    ];
    const chapters = [chapter({ paragraphs: [paragraph('a'.repeat(50))] })];
    const report = buildQualityReport(chapters, 50, 50, pages);
    const coverage = report.checks.find((c) => c.check === 'page_coverage')!;
    expect(coverage.outcome).toBe('NEEDS_REVIEW');
    expect(coverage.detail).toContain('2');
  });
});
