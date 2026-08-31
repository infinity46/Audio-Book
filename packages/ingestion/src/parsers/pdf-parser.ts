/**
 * PDF adapter over pdfjs-dist (task §18/§119 known limitation: the
 * architecture names "Marker" (Python) as the reference PDF tool, but
 * ingestion runs in the Node worker-cpu runtime — this is a Node-native
 * adapter behind the same DocumentParser interface; see the plan's "Known
 * limitations" section). Handles digital text directly; a page with no
 * extractable text is rasterized and routed through the injected
 * OCRProvider (task §26 "detect whether a page already has usable text"),
 * falling back to NEEDS_REVIEW/OCR_UNAVAILABLE only when no OCR provider
 * is configured at all.
 */
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { FileTooLargeError, CorruptedFileError, IngestionTimeoutError } from '../errors.js';
import { withTimeout } from '../timeout.js';
import {
  detectNoise,
  isPageNumberLike,
  type PageLevelBlock,
} from '../normalize/noise-detection.js';
import type { ExtractedBlock, ExtractedDocument, ExtractedPage, ParserIdentity } from '../model.js';
import type { DocumentParser, DocumentParserInput } from './parser.js';

const PARSER_IDENTITY: ParserIdentity = {
  providerId: 'pdfjs-dist',
  modelId: 'pdf-text-extractor',
  version: '4.9.155',
};

interface PdfLine {
  text: string;
  y: number;
  fontSize: number;
  x: number;
}

export class PdfParser implements DocumentParser {
  readonly identity = PARSER_IDENTITY;

  async parse(input: DocumentParserInput): Promise<ExtractedDocument> {
    const pdfjsLib = await loadPdfjs();

    let doc;
    try {
      doc = await withTimeout(
        pdfjsLib.getDocument({
          data: new Uint8Array(input.buffer),
          useSystemFonts: true,
          isEvalSupported: false,
          disableFontFace: true,
        }).promise,
        input.config.parserTimeoutMs,
        'Opening PDF',
      );
    } catch (err) {
      if (err instanceof IngestionTimeoutError) throw err;
      throw new CorruptedFileError({ message: 'PDF could not be opened.', cause: err });
    }

    try {
      if (doc.numPages > input.config.maxPages) {
        throw new FileTooLargeError({
          message: `PDF has ${doc.numPages} pages, exceeding the configured limit of ${input.config.maxPages}.`,
        });
      }

      // Pass 1: extract lines per page. The heading-detection font-size
      // threshold must be a document-wide baseline, not a per-page median —
      // a sparse page (e.g. only a header/footer plus one body line) would
      // otherwise let the header's small font skew that page's own median
      // and misclassify the lone body line as a heading.
      const linesByPage = new Map<number, PdfLine[]>();
      const ocrTextByPage = new Map<number, { text: string; confidence: number }>();
      const pages: ExtractedPage[] = [];

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await withTimeout(
          doc.getPage(pageNumber),
          input.config.parserTimeoutMs,
          `Opening page ${pageNumber}`,
        );
        try {
          const textContent = await page.getTextContent();
          const lines = groupItemsIntoLines(textContent.items);
          const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);

          if (charCount === 0) {
            const hasImages = await pageHasImageContent(page);
            if (!hasImages) {
              // Legitimately blank page (task §68) — not an error.
              pages.push({
                pageNumber,
                extractionMethod: 'DIGITAL_TEXT',
                status: 'OK',
                charCount: 0,
              });
              continue;
            }

            pages.push(await this.ocrPage(page, pageNumber, input, ocrTextByPage));
            continue;
          }

          linesByPage.set(pageNumber, lines);
          pages.push({ pageNumber, extractionMethod: 'DIGITAL_TEXT', status: 'OK', charCount });
        } finally {
          page.cleanup();
        }
      }

      // Strip repeated headers/footers/page numbers at the LINE level,
      // before paragraph grouping (task §36-§38). This must happen before
      // pass 2: once a header/footer line is merged into a paragraph
      // alongside body text (which naturally happens on pages with no
      // heading to force a break), it can no longer be cleanly separated
      // back out — position + repetition evidence is only unambiguous
      // while each candidate is still its own line.
      stripHeaderFooterNoiseLines(linesByPage, input.config.headerFooterConfidenceThreshold);
      const cleanedAllLines = [...linesByPage.values()].flat();

      const documentBodyFontSize = dominantFontSizeByCharWeight(cleanedAllLines);

      // Pass 2: segment each page's lines into paragraphs/headings using the
      // document-wide font baseline (paragraph-break gaps stay page-local —
      // layout spacing is consistent within a page's own coordinate system).
      const blocks: ExtractedBlock[] = [];
      let order = 0;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const lines = linesByPage.get(pageNumber);
        if (lines) {
          const paragraphs = groupLinesIntoParagraphs(lines, documentBodyFontSize);
          for (const paragraph of paragraphs) {
            blocks.push({
              order: order++,
              type: paragraph.isHeading ? 'HEADING' : 'PARAGRAPH',
              text: paragraph.text,
              headingLevel: paragraph.isHeading ? 1 : undefined,
              locator: { kind: 'pdf', page: pageNumber, blockIndex: paragraph.blockIndex },
              extractionMethod: 'DIGITAL_TEXT',
            });
          }
          continue;
        }

        const ocr = ocrTextByPage.get(pageNumber);
        if (!ocr) continue;
        // OCR text has no reliable font-size signal, so it is never treated
        // as a heading candidate — just paragraph-per-blank-line-group.
        const ocrParagraphs = ocr.text
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        ocrParagraphs.forEach((text, blockIndex) => {
          blocks.push({
            order: order++,
            type: 'PARAGRAPH',
            text,
            locator: { kind: 'pdf', page: pageNumber, blockIndex },
            extractionMethod: 'OCR',
            confidence: ocr.confidence,
          });
        });
      }

      return {
        sourceKind: 'PDF',
        pages,
        blocks,
        parserIdentity: this.identity,
        metadata: await extractMetadata(doc),
      };
    } finally {
      await doc.destroy();
    }
  }

  /**
   * Rasterizes an image-only page and routes it through the injected
   * OCRProvider. Never fabricates content: a missing provider, a
   * rasterization failure, an OCR failure, or empty OCR output all become
   * an explicit NEEDS_REVIEW/FAILED page status (task §30/§128) — the
   * successful-OCR text is stashed in `ocrTextByPage` for pass 2 to turn
   * into paragraph blocks in the correct page order.
   */
  private async ocrPage(
    page: PdfPageProxy,
    pageNumber: number,
    input: DocumentParserInput,
    ocrTextByPage: Map<number, { text: string; confidence: number }>,
  ): Promise<ExtractedPage> {
    if (input.ocrProvider.identity === null) {
      return {
        pageNumber,
        extractionMethod: 'OCR',
        status: 'NEEDS_REVIEW',
        failureReasonCode: 'OCR_UNAVAILABLE',
        charCount: 0,
      };
    }

    let png: Buffer;
    try {
      png = await withTimeout(
        rasterizePage(page, input.config.ocrRasterScale),
        input.config.parserTimeoutMs,
        `Rasterizing page ${pageNumber}`,
      );
    } catch {
      return {
        pageNumber,
        extractionMethod: 'OCR',
        status: 'FAILED',
        failureReasonCode: 'RASTERIZATION_FAILED',
        charCount: 0,
      };
    }

    let ocrResult;
    try {
      ocrResult = await withTimeout(
        input.ocrProvider.ocrPage({ image: png, language: input.config.ocrLanguage, pageNumber }),
        input.config.ocrTimeoutMs,
        `OCR of page ${pageNumber}`,
      );
    } catch {
      return {
        pageNumber,
        extractionMethod: 'OCR',
        status: 'FAILED',
        failureReasonCode: 'OCR_FAILED',
        charCount: 0,
      };
    }

    const text = ocrResult.text.trim();
    if (text.length === 0) {
      return {
        pageNumber,
        extractionMethod: 'OCR',
        status: 'NEEDS_REVIEW',
        failureReasonCode: 'OCR_EMPTY_RESULT',
        charCount: 0,
        confidence: ocrResult.confidence,
      };
    }

    ocrTextByPage.set(pageNumber, { text, confidence: ocrResult.confidence });
    const needsReview = ocrResult.confidence < input.config.ocrLowConfidenceThreshold;
    return {
      pageNumber,
      extractionMethod: 'OCR',
      status: needsReview ? 'NEEDS_REVIEW' : 'OK',
      failureReasonCode: needsReview ? 'OCR_LOW_CONFIDENCE' : undefined,
      charCount: text.length,
      confidence: ocrResult.confidence,
    };
  }
}

function rasterizePage(page: PdfPageProxy, scale: number): Promise<Buffer> {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  return page
    .render({ canvasContext: context, viewport })
    .promise.then(() => canvas.toBuffer('image/png'));
}

interface PdfTextItem {
  str: string;
  transform: number[];
  hasEOL: boolean;
}

function groupItemsIntoLines(items: PdfTextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let current: { text: string; y: number; fontSize: number; x: number } | null = null;

  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const fontSize = Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0);
    // pdf.js emits an empty, hasEOL:true "boundary" item whose own transform
    // describes the position/font of the NEXT line, not the one ending —
    // folding its font size into `current` via max() would corrupt the
    // current line's font size whenever the next line's font is larger.
    const hasText = item.str.length > 0;

    if (!current) {
      current = { text: item.str, y, fontSize: hasText ? fontSize : 0, x };
    } else if (hasText) {
      current.text += item.str;
      current.fontSize = Math.max(current.fontSize, fontSize);
    }

    if (item.hasEOL) {
      lines.push({
        text: current.text.trim(),
        y: current.y,
        fontSize: current.fontSize,
        x: current.x,
      });
      current = null;
    }
  }
  if (current && current.text.trim().length > 0) {
    lines.push({
      text: current.text.trim(),
      y: current.y,
      fontSize: current.fontSize,
      x: current.x,
    });
  }
  return lines;
}

/**
 * Mutates `linesByPage` in place, removing lines identified as repeated
 * headers/footers or page numbers using the shared cross-page repetition
 * evidence in normalize/noise-detection.ts. Runs on the FIRST and LAST
 * non-empty line of every page, mirroring the position-based candidate
 * selection the noise-detection module expects.
 */
function stripHeaderFooterNoiseLines(
  linesByPage: Map<number, PdfLine[]>,
  confidenceThreshold: number,
): void {
  const boundaryBlocks: PageLevelBlock[] = [];
  for (const [pageNumber, lines] of linesByPage) {
    if (lines.length === 0) continue;
    boundaryBlocks.push({ pageNumber, positionOnPage: 'first', text: lines[0]!.text });
    if (lines.length > 1) {
      boundaryBlocks.push({
        pageNumber,
        positionOnPage: 'last',
        text: lines[lines.length - 1]!.text,
      });
    }
  }

  const noise = detectNoise(boundaryBlocks, confidenceThreshold);
  if (noise.removedTexts.size === 0 && !noise.pageNumberPattern) return;

  for (const [pageNumber, lines] of linesByPage) {
    const filtered = lines.filter((line, index) => {
      const normalized = line.text.trim().replace(/\s+/g, ' ').toLowerCase();
      if (noise.removedTexts.has(normalized)) return false;
      if (noise.pageNumberPattern && isPageNumberLike(line.text)) {
        const isBoundary = index === 0 || index === lines.length - 1;
        if (isBoundary) return false;
      }
      return true;
    });
    linesByPage.set(pageNumber, filtered);
  }
}

interface PdfParagraph {
  text: string;
  isHeading: boolean;
  blockIndex: number;
}

/**
 * Groups lines into paragraphs using blank-line/large-vertical-gap breaks,
 * and flags short, oversized-font single lines as headings — a
 * deliberately conservative heuristic (task §43: support multiple signals,
 * never hard-code one single heading format).
 */
function groupLinesIntoParagraphs(lines: PdfLine[], bodyFontSize: number): PdfParagraph[] {
  const nonEmpty = lines.filter((l) => l.text.length > 0);
  if (nonEmpty.length === 0) return [];

  const typicalGap = medianLineGap(nonEmpty);

  const paragraphs: PdfParagraph[] = [];
  let buffer: string[] = [];
  let blockIndex = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    // Joined with '\n' (not ' ') so normalizeText's dehyphenation can still
    // see a line-break immediately after a trailing hyphen — collapsing to
    // spaces here would destroy that signal before it's ever inspected.
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      paragraphs.push({ text, isHeading: false, blockIndex: blockIndex++ });
    }
    buffer = [];
  };

  for (let i = 0; i < nonEmpty.length; i += 1) {
    const line = nonEmpty[i]!;
    const prev = nonEmpty[i - 1];
    const gap = prev ? Math.abs(prev.y - line.y) : 0;
    const isHeadingCandidate =
      line.fontSize > bodyFontSize * 1.15 && line.text.length < 120 && !line.text.endsWith(',');

    const isNewParagraphBreak = prev !== undefined && typicalGap > 0 && gap > typicalGap * 1.6;

    if (isHeadingCandidate) {
      flush();
      paragraphs.push({ text: line.text, isHeading: true, blockIndex: blockIndex++ });
      continue;
    }

    if (isNewParagraphBreak) {
      flush();
    }
    buffer.push(line.text);
  }
  flush();

  return paragraphs;
}

/**
 * The document's body-text font size, chosen as whichever font size bucket
 * accounts for the most CHARACTERS (not the most lines). A plain
 * line-count median is fooled by pages carrying more short header/footer
 * lines than body lines; body paragraphs reliably dominate by character
 * volume even when they don't dominate by line count.
 */
function dominantFontSizeByCharWeight(lines: PdfLine[]): number {
  const totalsBySize = new Map<number, number>();
  for (const line of lines) {
    if (line.text.length === 0) continue;
    const bucket = Math.round(line.fontSize);
    totalsBySize.set(bucket, (totalsBySize.get(bucket) ?? 0) + line.text.length);
  }
  let best = 12;
  let bestChars = -1;
  for (const [size, chars] of totalsBySize) {
    if (chars > bestChars) {
      bestChars = chars;
      best = size;
    }
  }
  return best;
}

function medianLineGap(lines: PdfLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = Math.abs(lines[i - 1]!.y - lines[i]!.y);
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

interface PdfPageLike {
  getOperatorList(): Promise<{ fnArray: number[] }>;
}

async function pageHasImageContent(page: PdfPageLike): Promise<boolean> {
  try {
    const pdfjsLib = await loadPdfjs();
    const opList = await page.getOperatorList();
    const paintOps = new Set([
      pdfjsLib.OPS.paintImageXObject,
      pdfjsLib.OPS.paintInlineImageXObject,
      pdfjsLib.OPS.paintImageMaskXObject,
    ]);
    return opList.fnArray.some((op) => paintOps.has(op));
  } catch {
    // If we can't determine it, err toward NOT flagging OCR need (a
    // legitimately blank page is far more common than an undetectable
    // image), matching task §128's "no silent fallback" for the more
    // consequential direction (never fabricate content) while avoiding
    // spurious NEEDS_REVIEW noise for pages that are simply blank.
    return false;
  }
}

interface PdfMetadataInfo {
  Title?: string;
  Language?: string;
}

interface PdfDocumentLike {
  getMetadata(): Promise<{ info: PdfMetadataInfo }>;
}

async function extractMetadata(
  doc: PdfDocumentLike,
): Promise<{ title?: string; language?: string }> {
  try {
    const { info } = await doc.getMetadata();
    return {
      title: typeof info.Title === 'string' ? info.Title : undefined,
      language: typeof info.Language === 'string' ? info.Language : undefined,
    };
  } catch {
    return {};
  }
}

interface PdfjsModule {
  getDocument(params: {
    data: Uint8Array;
    useSystemFonts: boolean;
    isEvalSupported: boolean;
    disableFontFace: boolean;
  }): { promise: Promise<PdfDocumentProxy> };
  OPS: {
    paintImageXObject: number;
    paintInlineImageXObject: number;
    paintImageMaskXObject: number;
  };
  GlobalWorkerOptions: { workerSrc: string };
}

interface PdfDocumentProxy extends PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfRenderTask {
  promise: Promise<void>;
}

interface PdfPageProxy extends PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: unknown; viewport: PdfViewport }): PdfRenderTask;
  cleanup(): void;
}

let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

/** Lazily loaded + worker configured once per process (pdfjs-dist v4 Node/ESM requires a worker script path). */
async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModulePromise ??= (async () => {
    const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
    // createRequire's CJS-style resolve works identically under plain Node
    // and under Vitest's Vite-based module runner, unlike import.meta.resolve
    // (which Vite's SSR transform does not implement).
    const require = createRequire(import.meta.url);
    mod.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return mod;
  })();
  return pdfjsModulePromise;
}
