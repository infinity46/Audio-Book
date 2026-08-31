/**
 * Format detection by magic bytes, never by filename/extension alone (task
 * §7/§16). `declaredMimeType` is whatever the client claimed at upload time;
 * it is compared against the sniffed type and any mismatch is surfaced to
 * the caller rather than silently trusted.
 */
import { fileTypeFromBuffer } from 'file-type';
import { InvalidFileError, UnsupportedFormatError } from './errors.js';
import type { SourceKind } from './model.js';

export interface FormatDetectionResult {
  sourceKind: SourceKind;
  sniffedMimeType: string;
  declaredVsSniffedMatch: boolean;
}

const PDF_MAGIC = Buffer.from('%PDF-');

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);

export async function detectFormat(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<FormatDetectionResult> {
  if (buffer.length === 0) {
    throw new InvalidFileError({ message: 'Uploaded file is empty.' });
  }

  if (buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    return {
      sourceKind: 'PDF',
      sniffedMimeType: 'application/pdf',
      declaredVsSniffedMatch: declaredMimeType === 'application/pdf',
    };
  }

  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed?.mime === 'application/epub+zip') {
    return {
      sourceKind: 'EPUB',
      sniffedMimeType: sniffed.mime,
      declaredVsSniffedMatch: declaredMimeType === sniffed.mime,
    };
  }

  if (sniffed && IMAGE_MIME_TYPES.has(sniffed.mime)) {
    return {
      sourceKind: 'IMAGE_SET',
      sniffedMimeType: sniffed.mime,
      declaredVsSniffedMatch: declaredMimeType === sniffed.mime,
    };
  }

  // A bare ZIP that is actually an EPUB missing the mimetype-sniff signature
  // (file-type only recognizes EPUB when the first entry is the stored,
  // uncompressed `mimetype` file) — let the EPUB parser make the final call
  // by attempting to read META-INF/container.xml; if that fails it will
  // raise CorruptedFileError itself rather than us guessing here.
  if (sniffed?.mime === 'application/zip' && declaredMimeType === 'application/epub+zip') {
    return {
      sourceKind: 'EPUB',
      sniffedMimeType: sniffed.mime,
      declaredVsSniffedMatch: false,
    };
  }

  throw new UnsupportedFormatError({
    message: `Unrecognized or unsupported file format (sniffed: ${sniffed?.mime ?? 'unknown'}).`,
  });
}
