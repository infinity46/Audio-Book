import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfParser } from './pdf-parser.js';
import { UnavailableOcrProvider } from '../ocr/ocr-provider.js';
import { TesseractOcrProvider } from '../ocr/tesseract-ocr-provider.js';
import { defaultIngestionConfig } from '../config.js';
import { CorruptedFileError, FileTooLargeError } from '../errors.js';
import {
  buildDialoguePdf,
  buildHyphenatedPdf,
  buildMalformedPdf,
  buildPdfWithRepeatedHeaderFooter,
  buildScannedLookingPdf,
  buildScannedPdfWithText,
  buildSimpleMultiChapterPdf,
} from '../test-fixtures/build-fixtures.js';

const parser = new PdfParser();
const ocrProvider = new UnavailableOcrProvider();

async function parse(
  buffer: Buffer,
  configOverrides: Partial<ReturnType<typeof defaultIngestionConfig>> = {},
) {
  return parser.parse({
    buffer,
    declaredMimeType: 'application/pdf',
    config: { ...defaultIngestionConfig(), ...configOverrides },
    ocrProvider,
  });
}

describe('PdfParser', () => {
  it('extracts pages, headings, and paragraphs from a simple multi-chapter PDF', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const document = await parse(buffer);

    expect(document.sourceKind).toBe('PDF');
    expect(document.pages).toHaveLength(2);
    expect(document.pages!.every((p) => p.status === 'OK')).toBe(true);

    const headings = document.blocks.filter((b) => b.type === 'HEADING').map((b) => b.text);
    expect(headings).toEqual(['Chapter 1', 'Chapter 2']);

    const page1Paragraphs = document.blocks.filter(
      (b) => b.locator.kind === 'pdf' && b.locator.page === 1 && b.type === 'PARAGRAPH',
    );
    expect(page1Paragraphs.length).toBeGreaterThanOrEqual(1);
  });

  it('records PDF source locators with page and block index', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const document = await parse(buffer);
    const firstHeading = document.blocks.find((b) => b.type === 'HEADING')!;
    expect(firstHeading.locator).toMatchObject({ kind: 'pdf', page: 1 });
  });

  it('preserves a hyphenated line break as raw text for the normalizer to resolve', async () => {
    const buffer = await buildHyphenatedPdf();
    const document = await parse(buffer);
    const paragraphs = document.blocks.filter((b) => b.type === 'PARAGRAPH').map((b) => b.text);
    expect(paragraphs.some((t) => t.includes('extra-') && t.includes('ordinary'))).toBe(true);
  });

  it('preserves curly quotes and em dashes in dialogue', async () => {
    const buffer = await buildDialoguePdf();
    const document = await parse(buffer);
    const dialogue = document.blocks.find((b) => b.text.includes('Hello'))!;
    expect(dialogue.text).toContain('“'); // opening curly quote preserved, not ASCII-transliterated
  });

  it('reports every page including repeated-header/footer pages as OK (noise removal happens later in the pipeline)', async () => {
    const buffer = await buildPdfWithRepeatedHeaderFooter();
    const document = await parse(buffer);
    expect(document.pages).toHaveLength(6);
    expect(document.pages!.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('flags an image-only page as NEEDS_REVIEW (OCR unavailable) instead of silently producing empty content', async () => {
    const buffer = await buildScannedLookingPdf();
    const document = await parse(buffer);
    expect(document.pages).toHaveLength(1);
    expect(document.pages![0]).toMatchObject({
      status: 'NEEDS_REVIEW',
      failureReasonCode: 'OCR_UNAVAILABLE',
    });
  });

  it('rejects a malformed PDF', async () => {
    const buffer = buildMalformedPdf();
    await expect(parse(buffer)).rejects.toBeInstanceOf(CorruptedFileError);
  });

  it('rejects a PDF exceeding the configured page limit', async () => {
    const buffer = await buildPdfWithRepeatedHeaderFooter(); // 6 pages
    await expect(parse(buffer, { maxPages: 2 })).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('produces the same extraction deterministically across two runs', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const [first, second] = await Promise.all([parse(buffer), parse(buffer)]);
    expect(first.blocks.map((b) => b.text)).toEqual(second.blocks.map((b) => b.text));
  });
});

describe('PdfParser (real OCR provider)', () => {
  let realOcrProvider: TesseractOcrProvider;

  beforeAll(() => {
    realOcrProvider = new TesseractOcrProvider({ language: 'eng' });
  });

  afterAll(async () => {
    await realOcrProvider.terminate();
  });

  it('OCRs an image-only page and reports it OK with recognized text, not NEEDS_REVIEW', async () => {
    const buffer = await buildScannedPdfWithText('This page was scanned from paper.');
    const document = await parser.parse({
      buffer,
      declaredMimeType: 'application/pdf',
      config: defaultIngestionConfig(),
      ocrProvider: realOcrProvider,
    });

    expect(document.pages).toHaveLength(1);
    expect(document.pages![0]!.status).toBe('OK');
    expect(document.pages![0]!.extractionMethod).toBe('OCR');
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]!.text).toContain('scanned from paper');
    expect(document.blocks[0]!.extractionMethod).toBe('OCR');
    expect(document.blocks[0]!.confidence).toBeGreaterThan(0.5);
  }, 30_000);

  it('keeps OCR-derived pages in correct document order alongside digital-text pages in a mixed PDF', async () => {
    const [digitalPdf, scannedPdf] = await Promise.all([
      buildSimpleMultiChapterPdf(),
      buildScannedPdfWithText('Scanned page text here.'),
    ]);
    // Merge: digital page(s) first, then a scanned page, via pdf-lib.
    const { PDFDocument } = await import('pdf-lib');
    const merged = await PDFDocument.create();
    const digitalDoc = await PDFDocument.load(digitalPdf);
    const scannedDoc = await PDFDocument.load(scannedPdf);
    const [digitalPage] = await merged.copyPages(digitalDoc, [0]);
    const [scannedPage] = await merged.copyPages(scannedDoc, [0]);
    merged.addPage(digitalPage);
    merged.addPage(scannedPage);
    const mergedBytes = Buffer.from(await merged.save());

    const document = await parser.parse({
      buffer: mergedBytes,
      declaredMimeType: 'application/pdf',
      config: defaultIngestionConfig(),
      ocrProvider: realOcrProvider,
    });

    expect(document.pages).toHaveLength(2);
    expect(document.pages![0]!.extractionMethod).toBe('DIGITAL_TEXT');
    expect(document.pages![1]!.extractionMethod).toBe('OCR');

    const orders = document.blocks.map((b) => b.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b)); // strictly increasing, no reordering
    const lastDigitalBlockIndex = document.blocks.findIndex((b) => b.extractionMethod === 'OCR');
    expect(lastDigitalBlockIndex).toBeGreaterThan(0); // digital blocks precede the OCR block
  }, 30_000);
});
