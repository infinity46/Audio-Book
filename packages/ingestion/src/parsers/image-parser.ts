/**
 * Image adapter for `IMAGE_SET` source files (task §6/§50). Scope for this
 * pass: a single still image (JPEG/PNG/WEBP) or a multi-page image
 * container (TIFF) — each frame becomes one "page", OCR'd through the
 * injected OCRProvider. A ZIP-of-loose-images container is NOT supported
 * here (would need its own archive-security treatment akin to the EPUB
 * adapter's zip-bomb/path-traversal guards) — documented as a known
 * limitation rather than silently accepted.
 */
import sharp from 'sharp';
import { withTimeout } from '../timeout.js';
import { CorruptedFileError, FileTooLargeError } from '../errors.js';
import type { ExtractedBlock, ExtractedDocument, ExtractedPage, ParserIdentity } from '../model.js';
import type { DocumentParser, DocumentParserInput } from './parser.js';

const PARSER_IDENTITY: ParserIdentity = {
  providerId: 'audio-book-image-reader',
  modelId: 'image-ocr-reader',
  version: '1.0.0',
};

export class ImageParser implements DocumentParser {
  readonly identity = PARSER_IDENTITY;

  async parse(input: DocumentParserInput): Promise<ExtractedDocument> {
    const config = input.config;
    const probe = sharp(input.buffer, { limitInputPixels: config.maxImagePixels, failOn: 'error' });
    const rootMetadata = await probe.metadata().catch((err: unknown) => {
      throw new CorruptedFileError({ message: 'Image could not be decoded.', cause: err });
    });

    const pageCount = rootMetadata.pages ?? 1;
    if (pageCount > config.maxImagePages) {
      throw new FileTooLargeError({
        message: `Image set has ${pageCount} pages, exceeding the configured limit of ${config.maxImagePages}.`,
      });
    }

    const pages: ExtractedPage[] = [];
    const blocks: ExtractedBlock[] = [];
    let order = 0;

    for (let imageIndex = 0; imageIndex < pageCount; imageIndex += 1) {
      const page = await this.ocrFrame(input, imageIndex);
      pages.push(page.extractedPage);
      for (const paragraphText of page.paragraphs) {
        blocks.push({
          order: order++,
          type: 'PARAGRAPH',
          text: paragraphText,
          locator: { kind: 'image', imageIndex },
          extractionMethod: 'IMAGE_OCR',
          confidence: page.extractedPage.confidence,
        });
      }
    }

    return { sourceKind: 'IMAGE_SET', pages, blocks, parserIdentity: this.identity, metadata: {} };
  }

  private async ocrFrame(
    input: DocumentParserInput,
    imageIndex: number,
  ): Promise<{ extractedPage: ExtractedPage; paragraphs: string[] }> {
    const pageNumber = imageIndex + 1;
    const config = input.config;

    let frame;
    try {
      frame = sharp(input.buffer, {
        page: imageIndex,
        limitInputPixels: config.maxImagePixels,
        failOn: 'error',
      });
      const frameMeta = await frame.metadata();
      const width = frameMeta.width ?? 0;
      const height = frameMeta.height ?? 0;
      if (width > config.maxImageDimensionPx || height > config.maxImageDimensionPx) {
        throw new FileTooLargeError({
          message: `Image page ${pageNumber} (${width}x${height}) exceeds the maximum allowed dimension of ${config.maxImageDimensionPx}px.`,
        });
      }
    } catch (err) {
      if (err instanceof FileTooLargeError) throw err;
      return {
        extractedPage: {
          pageNumber,
          extractionMethod: 'IMAGE_OCR',
          status: 'FAILED',
          failureReasonCode: 'CORRUPTED_IMAGE',
          charCount: 0,
        },
        paragraphs: [],
      };
    }

    if (input.ocrProvider.identity === null) {
      return {
        extractedPage: {
          pageNumber,
          extractionMethod: 'IMAGE_OCR',
          status: 'NEEDS_REVIEW',
          failureReasonCode: 'OCR_UNAVAILABLE',
          charCount: 0,
        },
        paragraphs: [],
      };
    }

    let png: Buffer;
    try {
      png = await frame.png().toBuffer();
    } catch {
      return {
        extractedPage: {
          pageNumber,
          extractionMethod: 'IMAGE_OCR',
          status: 'FAILED',
          failureReasonCode: 'CORRUPTED_IMAGE',
          charCount: 0,
        },
        paragraphs: [],
      };
    }

    let ocrResult;
    try {
      ocrResult = await withTimeout(
        input.ocrProvider.ocrPage({ image: png, language: config.ocrLanguage, pageNumber }),
        config.ocrTimeoutMs,
        `OCR of image ${pageNumber}`,
      );
    } catch {
      return {
        extractedPage: {
          pageNumber,
          extractionMethod: 'IMAGE_OCR',
          status: 'FAILED',
          failureReasonCode: 'OCR_FAILED',
          charCount: 0,
        },
        paragraphs: [],
      };
    }

    const text = ocrResult.text.trim();
    if (text.length === 0) {
      return {
        extractedPage: {
          pageNumber,
          extractionMethod: 'IMAGE_OCR',
          status: 'NEEDS_REVIEW',
          failureReasonCode: 'OCR_EMPTY_RESULT',
          charCount: 0,
          confidence: ocrResult.confidence,
        },
        paragraphs: [],
      };
    }

    const needsReview = ocrResult.confidence < config.ocrLowConfidenceThreshold;
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    return {
      extractedPage: {
        pageNumber,
        extractionMethod: 'IMAGE_OCR',
        status: needsReview ? 'NEEDS_REVIEW' : 'OK',
        failureReasonCode: needsReview ? 'OCR_LOW_CONFIDENCE' : undefined,
        charCount: text.length,
        confidence: ocrResult.confidence,
      },
      paragraphs,
    };
  }
}
