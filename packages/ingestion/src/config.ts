/**
 * Ingestion pipeline configuration. Values here are the pure-pipeline
 * defaults; apps/worker-cpu overrides them from environment via
 * @audio-book/config's fail-fast Zod loader (packages/config/src/schemas.ts
 * ingestionEnvSchema) — this module has no knowledge of env vars.
 */
export interface IngestionConfig {
  /** Identifies this whole pipeline's behavior for BookVersion.pipelineVersion. */
  pipelineVersion: string;
  /** Identifies the normalization ruleset for reproducibility (task §57/§63). */
  normalizationVersion: string;
  maxFileSizeBytes: number;
  maxPages: number;
  maxEpubEntryCount: number;
  maxEpubUncompressedBytes: number;
  maxEpubEntryUncompressedBytes: number;
  parserTimeoutMs: number;
  normalizationTimeoutMs: number;
  dehyphenate: boolean;
  /** Minimum fraction of pages a line must repeat on (same normalized text, same relative position) to be treated as a header/footer. */
  headerFooterConfidenceThreshold: number;
  /** Pages with fewer extracted characters than this (per non-blank page) are flagged as needing OCR rather than treated as empty content. */
  minCharsPerPageForDigitalText: number;

  // ---- OCR (task §25/§29 — tuning only; provider SELECTION is the
  // worker's call-site concern, not config, so a provider swap never
  // touches this file) ----
  /** Tesseract language code(s), e.g. "eng" or "eng+fra" — never assumed to be English by a hardcoded default deep in the pipeline (task §29). */
  ocrLanguage: string;
  ocrTimeoutMs: number;
  /** Scale factor applied when rasterizing a PDF page for OCR — higher = sharper but slower/larger (task §71 resolution validation). */
  ocrRasterScale: number;
  /** Hard cap on a rasterized/decoded image's largest dimension, guarding against a decompression-bomb-style pixel flood (task §73/§105). */
  maxImageDimensionPx: number;
  /** Hard cap on total decoded pixels for a single image (task §26/§105). */
  maxImagePixels: number;
  /** Cap on frames read from a multi-page image container (e.g. TIFF). */
  maxImagePages: number;
  /** An OCR result below this confidence (0..1) is flagged NEEDS_REVIEW rather than accepted silently (task §27/§64/§65). */
  ocrLowConfidenceThreshold: number;
}

export const DEFAULT_INGESTION_CONFIG: IngestionConfig = {
  pipelineVersion: 'ingestion.v1',
  // v2: cross-page hyphenation is now rejoined (F-1). This changes canonical
  // text and therefore every downstream content hash, so the version moves
  // with it — historical BookVersions stay attributable to normalize.v1.
  normalizationVersion: 'normalize.v2',
  maxFileSizeBytes: 200 * 1024 * 1024,
  maxPages: 3000,
  maxEpubEntryCount: 10_000,
  maxEpubUncompressedBytes: 500 * 1024 * 1024,
  maxEpubEntryUncompressedBytes: 100 * 1024 * 1024,
  parserTimeoutMs: 120_000,
  normalizationTimeoutMs: 60_000,
  dehyphenate: true,
  headerFooterConfidenceThreshold: 0.6,
  minCharsPerPageForDigitalText: 20,
  ocrLanguage: 'eng',
  ocrTimeoutMs: 60_000,
  ocrRasterScale: 2.0,
  maxImageDimensionPx: 10_000,
  maxImagePixels: 100_000_000,
  maxImagePages: 3000,
  ocrLowConfidenceThreshold: 0.6,
};

export function defaultIngestionConfig(): IngestionConfig {
  return { ...DEFAULT_INGESTION_CONFIG };
}

/**
 * Identifies the concrete parser library versions a `parse_book` job's
 * idempotency key is scoped to (distinct from `pipelineVersion`, which
 * covers the whole pipeline's behavior for `BookVersion.pipelineVersion`).
 * Shared by apps/api's book-upload flow and worker-cpu's ProcessingJobSweeper
 * so a re-enqueued job's idempotency key always matches the original.
 */
export const PARSER_VERSION_FOR_IDEMPOTENCY = 'pdfjs-dist@4.9.155+epub-spine-reader@1.0.0';
