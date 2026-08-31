import { describe, expect, it } from 'vitest';
import { detectStructure } from './detect-structure.js';
import { defaultIngestionConfig } from '../config.js';
import type { ExtractedBlock, ExtractedDocument } from '../model.js';

function pdfBlock(
  order: number,
  type: ExtractedBlock['type'],
  text: string,
  page = 1,
  headingLevel?: number,
): ExtractedBlock {
  return {
    order,
    type,
    text,
    headingLevel,
    locator: { kind: 'pdf', page, blockIndex: order },
    extractionMethod: 'DIGITAL_TEXT',
  };
}

function epubBlock(
  order: number,
  type: ExtractedBlock['type'],
  text: string,
  spineIndex: number,
  headingLevel?: number,
): ExtractedBlock {
  return {
    order,
    type,
    text,
    headingLevel,
    locator: { kind: 'epub', spineIndex, xpath: `/p[${order}]`, charOffset: 0 },
    extractionMethod: 'EPUB_SPINE',
  };
}

const config = defaultIngestionConfig();

describe('detectStructure (PDF-style input)', () => {
  it('starts a new chapter at a "Chapter N" heading and assigns monotonic spine positions', () => {
    const document: ExtractedDocument = {
      sourceKind: 'PDF',
      blocks: [
        pdfBlock(0, 'HEADING', 'Chapter 1', 1),
        pdfBlock(1, 'PARAGRAPH', 'First paragraph of chapter one.', 1),
        pdfBlock(2, 'PARAGRAPH', 'Second paragraph of chapter one.', 1),
        pdfBlock(3, 'HEADING', 'Chapter 2', 2),
        pdfBlock(4, 'PARAGRAPH', 'First paragraph of chapter two.', 2),
      ],
      parserIdentity: { providerId: 'test', modelId: 'test', version: '1' },
      metadata: {},
    };

    const { chapters, warnings } = detectStructure(document, config);
    expect(warnings).toEqual([]);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.title).toBe('Chapter 1');
    expect(chapters[0]!.paragraphs.map((p) => p.text)).toEqual([
      'First paragraph of chapter one.',
      'Second paragraph of chapter one.',
    ]);
    expect(chapters[1]!.title).toBe('Chapter 2');

    const allSpinePositions = chapters.flatMap((c) => c.paragraphs.map((p) => p.spinePosition));
    expect(allSpinePositions).toEqual([0, 1, 2]);
    expect(chapters[0]!.spineStart).toBe(0);
    expect(chapters[0]!.spineEnd).toBe(1);
    expect(chapters[1]!.spineStart).toBe(2);
  });

  it('treats a non-chapter-pattern heading as a section within the current chapter', () => {
    const document: ExtractedDocument = {
      sourceKind: 'PDF',
      blocks: [
        pdfBlock(0, 'HEADING', 'Chapter 1', 1),
        pdfBlock(1, 'PARAGRAPH', 'Intro paragraph.', 1),
        pdfBlock(2, 'HEADING', 'A Minor Heading', 1),
        pdfBlock(3, 'PARAGRAPH', 'Section paragraph.', 1),
      ],
      parserIdentity: { providerId: 'test', modelId: 'test', version: '1' },
      metadata: {},
    };

    const { chapters } = detectStructure(document, config);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.sections).toHaveLength(1);
    expect(chapters[0]!.sections[0]!.title).toBe('A Minor Heading');
    expect(chapters[0]!.paragraphs[1]!.sectionOrderIndex).toBe(0);
  });

  it('classifies front matter and back matter by recognized titles', () => {
    const document: ExtractedDocument = {
      sourceKind: 'PDF',
      blocks: [
        pdfBlock(0, 'HEADING', 'Preface', 1),
        pdfBlock(1, 'PARAGRAPH', 'Preface content.', 1),
        pdfBlock(2, 'HEADING', 'Chapter 1', 2),
        pdfBlock(3, 'PARAGRAPH', 'Body content.', 2),
        pdfBlock(4, 'HEADING', 'Appendix', 3),
        pdfBlock(5, 'PARAGRAPH', 'Appendix content.', 3),
      ],
      parserIdentity: { providerId: 'test', modelId: 'test', version: '1' },
      metadata: {},
    };

    const { chapters } = detectStructure(document, config);
    expect(chapters.map((c) => c.matterType)).toEqual(['FRONT_MATTER', 'BODY', 'BACK_MATTER']);
  });

  it('warns when a chapter has no paragraphs', () => {
    const document: ExtractedDocument = {
      sourceKind: 'PDF',
      blocks: [pdfBlock(0, 'HEADING', 'Chapter 1', 1)],
      parserIdentity: { providerId: 'test', modelId: 'test', version: '1' },
      metadata: {},
    };
    const { warnings } = detectStructure(document, config);
    expect(warnings.some((w) => w.includes('POSSIBLE_MISSING_TEXT'))).toBe(true);
  });
});

describe('detectStructure (EPUB-style input)', () => {
  it('treats each spine item as a chapter boundary', () => {
    const document: ExtractedDocument = {
      sourceKind: 'EPUB',
      blocks: [
        epubBlock(0, 'HEADING', 'Chapter One', 0, 1),
        epubBlock(1, 'PARAGRAPH', 'Content of chapter one.', 0),
        epubBlock(2, 'HEADING', 'Chapter Two', 1, 1),
        epubBlock(3, 'PARAGRAPH', 'Content of chapter two.', 1),
      ],
      parserIdentity: { providerId: 'test', modelId: 'test', version: '1' },
      metadata: {},
    };

    const { chapters } = detectStructure(document, config);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.title).toBe('Chapter One');
    expect(chapters[1]!.title).toBe('Chapter Two');
  });
});
