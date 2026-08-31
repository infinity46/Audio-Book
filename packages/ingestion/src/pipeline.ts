/**
 * The pure orchestration entry point (task §142 implementation order,
 * collapsed into one function): format detection -> parse -> noise removal
 * -> normalize -> structure detection -> canonical build -> quality report
 * -> hashes. No Prisma/BullMQ/StorageProvider imports — testable by passing
 * a Buffer in and asserting the structure out (task §140 testability).
 * apps/worker-cpu's processor is the thin adapter that fetches bytes and
 * persists this result.
 */
import { detectFormat } from './detect-format.js';
import { defaultIngestionConfig, type IngestionConfig } from './config.js';
import { FileTooLargeError } from './errors.js';
import { sha256Hex, configHash } from './hashing.js';
import { detectStructure, type CanonicalChapter } from './structure/detect-structure.js';
import { renderMarkdown } from './canonical/build-canonical.js';
import { buildQualityReport, type QualityReport } from './quality-report.js';
import { EpubParser } from './parsers/epub-parser.js';
import { PdfParser } from './parsers/pdf-parser.js';
import { ImageParser } from './parsers/image-parser.js';
import type { DocumentParser } from './parsers/parser.js';
import { UnavailableOcrProvider, type OCRProvider } from './ocr/ocr-provider.js';
import type { ExtractedBlock, ExtractedPage, ParserIdentity, SourceKind } from './model.js';

export interface RunIngestionPipelineInput {
  buffer: Buffer;
  declaredMimeType: string;
  config?: IngestionConfig;
  ocrProvider?: OCRProvider;
}

export interface IngestionResult {
  sourceKind: SourceKind;
  chapters: CanonicalChapter[];
  pages?: ExtractedPage[];
  warnings: string[];
  qualityReport: QualityReport;
  parserIdentity: ParserIdentity;
  ocrIdentity: { providerId: string; modelId: string; version: string } | null;
  normalizationVersion: string;
  configHash: string;
  rawTextContentHash: string;
  contentHash: string;
  markdown: string;
  metadata: { title?: string; language?: string };
}

const PARSERS: Record<SourceKind, () => DocumentParser> = {
  PDF: () => new PdfParser(),
  EPUB: () => new EpubParser(),
  IMAGE_SET: () => new ImageParser(),
};

export async function runIngestionPipeline(
  input: RunIngestionPipelineInput,
): Promise<IngestionResult> {
  const config = input.config ?? defaultIngestionConfig();
  const ocrProvider = input.ocrProvider ?? new UnavailableOcrProvider();

  if (input.buffer.byteLength > config.maxFileSizeBytes) {
    throw new FileTooLargeError({
      message: `File is ${input.buffer.byteLength} bytes, exceeding the configured limit of ${config.maxFileSizeBytes}.`,
    });
  }

  const format = await detectFormat(input.buffer, input.declaredMimeType);
  const parser = PARSERS[format.sourceKind]();
  const document = await parser.parse({
    buffer: input.buffer,
    declaredMimeType: input.declaredMimeType,
    config,
    ocrProvider,
  });

  // Header/footer/page-number noise is already stripped by the parser
  // itself (at the line level, before paragraph grouping — see
  // pdf-parser.ts's stripHeaderFooterNoiseLines) since removing it only
  // after lines have been merged into paragraph blocks can no longer
  // cleanly separate the two. `document.blocks` here is already clean.
  const rawCharCount = sumBlockChars(document.blocks);
  const { chapters, warnings } = detectStructure(document, config);

  const normalizedCharCount = chapters.reduce(
    (sum, ch) => sum + ch.paragraphs.reduce((s, p) => s + p.text.length, 0),
    0,
  );

  const qualityReport = buildQualityReport(
    chapters,
    rawCharCount,
    normalizedCharCount,
    document.pages,
  );

  const rawTextContentHash = sha256Hex(document.blocks.map((b) => b.text).join('\n'));
  const contentHash = sha256Hex(
    chapters.flatMap((c) => c.paragraphs.map((p) => p.text)).join('\n'),
  );

  return {
    sourceKind: format.sourceKind,
    chapters,
    pages: document.pages,
    warnings,
    qualityReport,
    parserIdentity: document.parserIdentity,
    ocrIdentity: ocrProvider.identity,
    normalizationVersion: config.normalizationVersion,
    configHash: configHash(config),
    rawTextContentHash,
    contentHash,
    markdown: renderMarkdown(chapters),
    metadata: document.metadata,
  };
}

function sumBlockChars(blocks: ExtractedBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.text.length, 0);
}
