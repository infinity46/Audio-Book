import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIngestionPipeline } from './pipeline.js';
import { defaultIngestionConfig } from './config.js';
import { FileTooLargeError, UnsupportedFormatError } from './errors.js';
import { TesseractOcrProvider } from './ocr/tesseract-ocr-provider.js';
import {
  buildEpub2,
  buildHyphenatedPdf,
  buildImageWithText,
  buildPdfWithRepeatedHeaderFooter,
  buildScannedPdfWithText,
  buildSimpleMultiChapterPdf,
} from './test-fixtures/build-fixtures.js';

describe('runIngestionPipeline (PDF)', () => {
  it('produces canonical chapters, a markdown artifact, and content hashes from a simple PDF', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });

    expect(result.sourceKind).toBe('PDF');
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0]!.title).toBe('Chapter 1');
    expect(result.markdown).toContain('# Chapter 1');
    expect(result.markdown).toContain('# Chapter 2');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawTextContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.qualityReport.outcome).toBe('PASS');
    expect(result.parserIdentity.providerId).toBe('pdfjs-dist');
    expect(result.ocrIdentity).toBeNull();
  });

  it('removes repeated headers/footers/page numbers before structure detection', async () => {
    const buffer = await buildPdfWithRepeatedHeaderFooter();
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });

    const allText = result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).not.toContain('THE GREAT BOOK');
    // Page-number-only lines like a bare "3" must not surface as their own paragraph.
    for (const chapter of result.chapters) {
      for (const paragraph of chapter.paragraphs) {
        expect(paragraph.text.trim()).not.toMatch(/^\d{1,2}$/);
      }
    }
  });

  it('dehyphenates a line-break hyphenation end to end', async () => {
    const buffer = await buildHyphenatedPdf();
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });
    const allText = result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('extraordinary');
  });

  it('is deterministic: identical input and config produce identical content hashes', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const [first, second] = await Promise.all([
      runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' }),
      runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' }),
    ]);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.rawTextContentHash).toBe(second.rawTextContentHash);
  });

  it('rejects a file larger than the configured size limit before ever parsing it', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    await expect(
      runIngestionPipeline({
        buffer,
        declaredMimeType: 'application/pdf',
        config: { ...defaultIngestionConfig(), maxFileSizeBytes: 10 },
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('rejects an unsupported/unrecognized format', async () => {
    await expect(
      runIngestionPipeline({
        buffer: Buffer.from('plain text file'),
        declaredMimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
  });
});

describe('runIngestionPipeline (EPUB)', () => {
  it('produces canonical chapters and a markdown artifact from an EPUB', async () => {
    const buffer = await buildEpub2();
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/epub+zip' });

    expect(result.sourceKind).toBe('EPUB');
    expect(result.chapters).toHaveLength(2);
    expect(result.markdown).toContain('# Chapter 1');
    expect(result.qualityReport.outcome).toBe('PASS');
  });
});

describe('runIngestionPipeline (OCR-backed scanned PDF and image sets)', () => {
  let ocrProvider: TesseractOcrProvider;

  beforeAll(() => {
    ocrProvider = new TesseractOcrProvider({ language: 'eng' });
  });

  afterAll(async () => {
    await ocrProvider.terminate();
  });

  it('ingests a scanned (image-only) PDF end to end when a real OCR provider is supplied', async () => {
    const buffer = await buildScannedPdfWithText('This chapter was scanned from paper.');
    const result = await runIngestionPipeline({
      buffer,
      declaredMimeType: 'application/pdf',
      ocrProvider,
    });

    expect(result.sourceKind).toBe('PDF');
    expect(result.ocrIdentity).not.toBeNull();
    expect(result.pages![0]!.status).toBe('OK');
    const allText = result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('scanned from paper');
    expect(result.qualityReport.outcome).toBe('PASS');
  }, 30_000);

  it('ingests a standalone image (IMAGE_SET) end to end when a real OCR provider is supplied', async () => {
    const buffer = buildImageWithText('A single scanned page of text.');
    const result = await runIngestionPipeline({
      buffer,
      declaredMimeType: 'image/png',
      ocrProvider,
    });

    expect(result.sourceKind).toBe('IMAGE_SET');
    const allText = result.chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('A single scanned page');
  }, 30_000);

  it('flags a scanned PDF NEEDS_REVIEW rather than fabricating content when no OCR provider is supplied', async () => {
    const buffer = await buildScannedPdfWithText('Should not be silently dropped.');
    const result = await runIngestionPipeline({ buffer, declaredMimeType: 'application/pdf' });

    expect(result.ocrIdentity).toBeNull();
    expect(result.pages![0]!.status).toBe('NEEDS_REVIEW');
    expect(result.pages![0]!.failureReasonCode).toBe('OCR_UNAVAILABLE');
    // page_coverage sees a flagged-but-present page (not a missing one), so it's WARN, not NEEDS_REVIEW —
    // the correctness property under test is that the page is flagged at all, never silently dropped.
    expect(result.qualityReport.outcome).toBe('WARN');
  }, 30_000);
});
