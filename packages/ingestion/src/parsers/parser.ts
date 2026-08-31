import type { ExtractedDocument, ParserIdentity } from '../model.js';
import type { IngestionConfig } from '../config.js';
import type { OCRProvider } from '../ocr/ocr-provider.js';

export interface DocumentParserInput {
  buffer: Buffer;
  declaredMimeType: string;
  config: IngestionConfig;
  ocrProvider: OCRProvider;
}

/**
 * Provider-independent parsing seam (task §17/§19): the ingestion
 * orchestrator (pipeline.ts) depends only on this interface, never on
 * pdfjs-dist/yauzl/etc. directly, so a future adapter (e.g. a Marker
 * microservice call) is a new class, not a rewrite of the pipeline.
 */
export interface DocumentParser {
  readonly identity: ParserIdentity;
  parse(input: DocumentParserInput): Promise<ExtractedDocument>;
}
