import { describe, expect, it } from 'vitest';
import { detectFormat } from './detect-format.js';
import { InvalidFileError, UnsupportedFormatError } from './errors.js';
import {
  buildEpub2,
  buildImageWithText,
  buildSimpleMultiChapterPdf,
} from './test-fixtures/build-fixtures.js';

describe('detectFormat', () => {
  it('detects a PDF by magic bytes regardless of declared MIME type', async () => {
    const buffer = await buildSimpleMultiChapterPdf();
    const result = await detectFormat(buffer, 'application/octet-stream');
    expect(result.sourceKind).toBe('PDF');
    expect(result.sniffedMimeType).toBe('application/pdf');
    expect(result.declaredVsSniffedMatch).toBe(false);
  });

  it('detects an EPUB by magic bytes/zip signature', async () => {
    const buffer = await buildEpub2();
    const result = await detectFormat(buffer, 'application/epub+zip');
    expect(result.sourceKind).toBe('EPUB');
  });

  it('detects a PNG image as IMAGE_SET by magic bytes', async () => {
    const buffer = buildImageWithText('hello');
    const result = await detectFormat(buffer, 'image/png');
    expect(result.sourceKind).toBe('IMAGE_SET');
    expect(result.sniffedMimeType).toBe('image/png');
  });

  it('rejects an empty file', async () => {
    await expect(detectFormat(Buffer.alloc(0), 'application/pdf')).rejects.toBeInstanceOf(
      InvalidFileError,
    );
  });

  it('rejects an unrecognized format', async () => {
    await expect(
      detectFormat(Buffer.from('just some plain text'), 'text/plain'),
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
  });
});
