import { describe, expect, it } from 'vitest';
import { EpubParser } from './epub-parser.js';
import { UnavailableOcrProvider } from '../ocr/ocr-provider.js';
import { defaultIngestionConfig } from '../config.js';
import { CorruptedFileError, FileTooLargeError, SecurityViolationError } from '../errors.js';
import {
  buildEpub2,
  buildEpub3,
  buildEpubWithPathTraversal,
  buildMalformedEpub,
} from '../test-fixtures/build-fixtures.js';

const parser = new EpubParser();
const ocrProvider = new UnavailableOcrProvider();

async function parse(
  buffer: Buffer,
  configOverrides: Partial<ReturnType<typeof defaultIngestionConfig>> = {},
) {
  return parser.parse({
    buffer,
    declaredMimeType: 'application/epub+zip',
    config: { ...defaultIngestionConfig(), ...configOverrides },
    ocrProvider,
  });
}

describe('EpubParser', () => {
  it('extracts chapters and paragraphs from an EPUB2 book in spine order', async () => {
    const buffer = await buildEpub2();
    const document = await parse(buffer);

    expect(document.sourceKind).toBe('EPUB');
    expect(document.metadata.title).toBe('Synthetic Test Book');
    expect(document.metadata.language).toBe('en');

    const headings = document.blocks.filter((b) => b.type === 'HEADING').map((b) => b.text);
    expect(headings).toEqual(['Chapter 1', 'Chapter 2']);

    const paragraphs = document.blocks.filter((b) => b.type === 'PARAGRAPH').map((b) => b.text);
    expect(paragraphs).toEqual([
      'It was a bright cold day when the story began.',
      'She walked through the door without looking back.',
      'The second chapter begins here, quite differently than the first.',
    ]);

    // Order must be document order, not just insertion order coincidence.
    expect(document.blocks.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('extracts chapters from an EPUB3 book with a nav document without treating nav as a chapter', async () => {
    const buffer = await buildEpub3();
    const document = await parse(buffer);
    const headings = document.blocks.filter((b) => b.type === 'HEADING').map((b) => b.text);
    expect(headings).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('records EPUB source locators with spine index', async () => {
    const buffer = await buildEpub2();
    const document = await parse(buffer);
    const firstParagraph = document.blocks.find((b) => b.type === 'PARAGRAPH')!;
    expect(firstParagraph.locator).toMatchObject({ kind: 'epub', spineIndex: 0 });
    const secondChapterParagraph = document.blocks.filter((b) => b.type === 'PARAGRAPH')[2]!;
    expect(secondChapterParagraph.locator).toMatchObject({ kind: 'epub', spineIndex: 1 });
  });

  it('rejects a malformed EPUB (missing OPF)', async () => {
    const buffer = await buildMalformedEpub();
    await expect(parse(buffer)).rejects.toBeInstanceOf(CorruptedFileError);
  });

  it('rejects a path-traversal manifest href', async () => {
    const buffer = await buildEpubWithPathTraversal();
    await expect(parse(buffer)).rejects.toBeInstanceOf(SecurityViolationError);
  });

  it('rejects an EPUB whose declared entry size exceeds the per-entry limit', async () => {
    const buffer = await buildEpub2();
    await expect(parse(buffer, { maxEpubEntryUncompressedBytes: 10 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it('rejects an EPUB with more entries than the configured cap', async () => {
    const buffer = await buildEpub2();
    await expect(parse(buffer, { maxEpubEntryCount: 1 })).rejects.toBeInstanceOf(
      SecurityViolationError,
    );
  });
});
