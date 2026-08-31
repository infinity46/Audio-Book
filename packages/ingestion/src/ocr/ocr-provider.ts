/**
 * Provider-independent OCR seam (task §25/§119/§120). `UnavailableOcrProvider`
 * never fabricates text for a page it can't read digitally — it returns a
 * structured, per-page failure so the caller can mark that page
 * NEEDS_REVIEW and continue with the rest of the book (task §30 "OCR
 * fallback" / §128 "no silent fallback"). `TesseractOcrProvider`
 * (tesseract-ocr-provider.ts) is the real engine behind the same interface.
 */

export interface OcrPageInput {
  /** Rasterized page image bytes (PNG/TIFF). Not used by UnavailableOcrProvider. */
  image: Buffer;
  language: string;
  pageNumber: number;
}

export interface OcrPageResult {
  text: string;
  confidence: number;
  engine: string;
  engineVersion: string;
  language: string;
}

export class OcrUnavailableError extends Error {
  constructor(pageNumber: number) {
    super(`OCR is not configured; page ${pageNumber} requires OCR but none is available.`);
    this.name = 'OcrUnavailableError';
  }
}

export interface OCRProvider {
  readonly identity: { providerId: string; modelId: string; version: string } | null;
  ocrPage(input: OcrPageInput): Promise<OcrPageResult>;
  /** Releases engine resources (e.g. a WASM worker thread). Optional — stateless providers need not implement it. */
  terminate?(): Promise<void>;
}

/** The default provider until a real OCR engine (task follow-up) is wired in. */
export class UnavailableOcrProvider implements OCRProvider {
  readonly identity = null;

  ocrPage(input: OcrPageInput): Promise<OcrPageResult> {
    throw new OcrUnavailableError(input.pageNumber);
  }
}
