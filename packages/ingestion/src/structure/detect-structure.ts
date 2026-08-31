/**
 * Chapter/section/paragraph segmentation (task §42-§46) and front/back
 * matter classification (task §40/§41). Uses heading signals already
 * produced by the parser (EPUB spine boundaries + `<h*>` tags; PDF
 * font-size-based HEADING blocks) rather than hard-coding one book layout.
 */
import { normalizeText } from '../normalize/normalize.js';
import { isPageNumberLike } from '../normalize/noise-detection.js';
import type { IngestionConfig } from '../config.js';
import type {
  ExtractedBlock,
  ExtractedDocument,
  ExtractionMethod,
  SourceLocator,
} from '../model.js';

export type MatterType = 'FRONT_MATTER' | 'BODY' | 'BACK_MATTER';

export interface CanonicalParagraph {
  orderIndex: number;
  spinePosition: number;
  text: string;
  rawText: string;
  sectionOrderIndex?: number;
  sourcePageNumber?: number;
  sourcePageEndNumber?: number;
  sourceLocator: SourceLocator;
  extractionMethod: ExtractionMethod;
  extractionConfidence?: number;
}

export interface CanonicalSection {
  orderIndex: number;
  spineStart: number;
  spineEnd: number;
  title?: string;
}

export interface CanonicalChapter {
  orderIndex: number;
  spineStart: number;
  spineEnd: number;
  title?: string;
  matterType: MatterType;
  sections: CanonicalSection[];
  paragraphs: CanonicalParagraph[];
}

export interface StructureResult {
  chapters: CanonicalChapter[];
  warnings: string[];
}

const CHAPTER_PATTERN =
  /^(chapter|part|book)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const BARE_ROMAN_OR_NUMBER = /^([ivxlcdm]{1,8}|\d{1,3})\.?$/i;

const FRONT_MATTER_TITLES = new Set([
  'title page',
  'copyright',
  'copyright page',
  'dedication',
  'epigraph',
  'preface',
  'foreword',
  'introduction',
  'contents',
  'table of contents',
  'acknowledgments',
  'acknowledgements',
]);
const BACK_MATTER_TITLES = new Set([
  'afterword',
  'appendix',
  'glossary',
  'bibliography',
  'index',
  'about the author',
  "author's note",
  'author note',
  'notes',
]);

function isChapterHeading(text: string): boolean {
  const trimmed = text.trim();
  if (CHAPTER_PATTERN.test(trimmed)) return true;
  if (BARE_ROMAN_OR_NUMBER.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return (
    FRONT_MATTER_TITLES.has(lower) ||
    BACK_MATTER_TITLES.has(lower) ||
    lower === 'prologue' ||
    lower === 'epilogue'
  );
}

function classifyMatterType(title: string | undefined): MatterType {
  if (!title) return 'BODY';
  const lower = title.trim().toLowerCase();
  if (FRONT_MATTER_TITLES.has(lower)) return 'FRONT_MATTER';
  if (BACK_MATTER_TITLES.has(lower)) return 'BACK_MATTER';
  return 'BODY';
}

interface RawChapter {
  title?: string;
  blocks: ExtractedBlock[];
}

export function detectStructure(
  document: ExtractedDocument,
  config: IngestionConfig,
): StructureResult {
  const warnings: string[] = [];
  const rawChapters = splitIntoChapters(document.blocks, document.sourceKind === 'EPUB');

  if (rawChapters.length === 0) {
    warnings.push(
      'POSSIBLE_MISSING_TEXT: no chapters could be identified from the extracted content.',
    );
  }

  let spineCounter = 0;
  const chapters: CanonicalChapter[] = [];

  rawChapters.forEach((raw, chapterIndex) => {
    const { paragraphs, sectionsList } = splitChapterIntoSections(raw.blocks, config);

    const chapterParagraphs: CanonicalParagraph[] = [];
    let paragraphOrder = 0;
    for (const p of paragraphs) {
      const spinePosition = spineCounter++;
      chapterParagraphs.push({ ...p, orderIndex: paragraphOrder++, spinePosition });
    }

    if (chapterParagraphs.length === 0) {
      warnings.push(
        `POSSIBLE_MISSING_TEXT: chapter ${chapterIndex} ("${raw.title ?? 'untitled'}") has no paragraphs.`,
      );
    }

    const spineValues = chapterParagraphs.map((p) => p.spinePosition);
    const spineStart = spineValues.length > 0 ? Math.min(...spineValues) : spineCounter;
    const spineEnd = spineValues.length > 0 ? Math.max(...spineValues) : spineCounter;

    const finalSections: CanonicalSection[] = sectionsList.map((s) => {
      const sectionParas = chapterParagraphs.filter((p) => p.sectionOrderIndex === s.orderIndex);
      const sectionSpineValues = sectionParas.map((p) => p.spinePosition);
      return {
        ...s,
        spineStart: sectionSpineValues.length > 0 ? Math.min(...sectionSpineValues) : spineStart,
        spineEnd: sectionSpineValues.length > 0 ? Math.max(...sectionSpineValues) : spineEnd,
      };
    });

    chapters.push({
      orderIndex: chapterIndex,
      spineStart,
      spineEnd,
      title: raw.title,
      matterType: classifyMatterType(raw.title),
      sections: finalSections,
      paragraphs: chapterParagraphs,
    });
  });

  return { chapters, warnings };
}

/** Splits the flat block list into chapters using heading signals — EPUB spine boundaries are a strong additional signal on top of headings. */
function splitIntoChapters(blocks: ExtractedBlock[], isEpub: boolean): RawChapter[] {
  const chapters: RawChapter[] = [];
  let current: RawChapter | null = null;
  let lastSpineIndex: number | null = null;

  for (const block of blocks) {
    const spineIndex = block.locator.kind === 'epub' ? block.locator.spineIndex : null;
    const newSpineItem = isEpub && spineIndex !== null && spineIndex !== lastSpineIndex;
    lastSpineIndex = spineIndex ?? lastSpineIndex;

    const isHeading = block.type === 'HEADING';
    const startsNewChapter =
      current === null ||
      newSpineItem ||
      (isHeading && !isEpub && isChapterHeading(block.text)) ||
      (isHeading && isEpub && (block.headingLevel ?? 2) === 1);

    if (startsNewChapter) {
      current = { blocks: [] };
      chapters.push(current);
      if (isHeading) {
        current.title = block.text;
        continue; // heading consumed as the chapter title, not also a paragraph.
      }
    }
    current!.blocks.push(block);
  }

  return chapters;
}

function splitChapterIntoSections(
  blocks: ExtractedBlock[],
  config: IngestionConfig,
): {
  sectionsList: Array<{ orderIndex: number; title?: string }>;
  paragraphs: Array<Omit<CanonicalParagraph, 'orderIndex' | 'spinePosition'>>;
} {
  const sectionsList: Array<{ orderIndex: number; title?: string }> = [];
  const paragraphs: Array<Omit<CanonicalParagraph, 'orderIndex' | 'spinePosition'>> = [];

  let currentSectionIndex: number | undefined;

  for (const block of blocks) {
    if (block.type === 'HEADING') {
      currentSectionIndex = sectionsList.length;
      sectionsList.push({ orderIndex: currentSectionIndex, title: block.text });
      continue;
    }

    if (block.type === 'PAGE_ARTIFACT') continue;
    if (isPageNumberLike(block.text)) continue; // defensive; primary removal happens upstream in pipeline.ts

    const rawText = block.text;
    const text = normalizeText(rawText, config);
    if (text.length === 0) continue;

    paragraphs.push({
      text,
      rawText,
      sectionOrderIndex: currentSectionIndex,
      sourcePageNumber: block.locator.kind === 'pdf' ? block.locator.page : undefined,
      sourcePageEndNumber: block.locator.kind === 'pdf' ? block.locator.page : undefined,
      sourceLocator: block.locator,
      extractionMethod: block.extractionMethod,
      extractionConfidence: block.confidence,
    });
  }

  return { sectionsList, paragraphs };
}
