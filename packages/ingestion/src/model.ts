/**
 * The raw/normalized extraction model — an internal intermediate
 * representation between "parser output" and the canonical structural
 * representation (chapters/paragraphs). This is deliberately NOT the Audio
 * Script IR (task §20/§55): it has no notion of speakers, scenes, TTS
 * directives, or narration — only source-faithful text with provenance.
 */

export type SourceKind = 'PDF' | 'EPUB' | 'IMAGE_SET';

export type ExtractionMethod = 'DIGITAL_TEXT' | 'OCR' | 'EPUB_SPINE' | 'IMAGE_OCR';

export type BlockType =
  | 'HEADING'
  | 'PARAGRAPH'
  | 'LIST_ITEM'
  | 'BLOCKQUOTE'
  | 'TABLE'
  | 'CAPTION'
  | 'FOOTNOTE'
  | 'PAGE_ARTIFACT';

/**
 * Where a block came from, in a format-appropriate shape (task §23/§24).
 * Exactly mirrors the shapes documented for `paragraph.source_locator` in
 * database-schema.md so persistence is a direct passthrough.
 */
export type SourceLocator =
  | { kind: 'pdf'; page: number; blockIndex: number; bbox?: [number, number, number, number] }
  | { kind: 'epub'; spineIndex: number; xpath: string; charOffset: number }
  | { kind: 'image'; imageIndex: number; region?: [number, number, number, number] };

export interface ExtractedBlock {
  /** Position among all blocks in the document, in reading order. */
  order: number;
  type: BlockType;
  text: string;
  headingLevel?: number;
  locator: SourceLocator;
  extractionMethod: ExtractionMethod;
  /** 0..1, present only for OCR-derived text. */
  confidence?: number;
}

export type ParsedPageOutcome = 'OK' | 'NEEDS_REVIEW' | 'FAILED';

export interface ExtractedPage {
  pageNumber: number;
  extractionMethod: ExtractionMethod;
  status: ParsedPageOutcome;
  failureReasonCode?: string;
  charCount: number;
  confidence?: number;
  blockConfidence?: Array<{ blockIndex: number; confidence: number }>;
}

export interface ExtractedDocument {
  sourceKind: SourceKind;
  /** Pages for PDF/IMAGE_SET provenance; absent for EPUB (no physical pages — task §23). */
  pages?: ExtractedPage[];
  blocks: ExtractedBlock[];
  parserIdentity: ParserIdentity;
  /** Document-level metadata the parser could recover (title, language hints), best-effort only. */
  metadata: { title?: string; language?: string };
}

export interface ParserIdentity {
  providerId: string;
  modelId: string;
  version: string;
}
