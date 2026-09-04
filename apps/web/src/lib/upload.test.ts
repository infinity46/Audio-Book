import { describe, expect, it } from 'vitest';
import { validateSourceFile } from './upload';

const limits = {
  acceptedMimeTypes: ['application/pdf', 'application/epub+zip'],
  maxBytes: 1000,
};

function file(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

/**
 * Client-side admission is a courtesy that fails fast; the backend re-downloads
 * the file, verifies the checksum, and sniffs the real format regardless.
 */
describe('validateSourceFile', () => {
  it('accepts a PDF and reports its source kind', () => {
    const result = validateSourceFile(file('book.pdf', 'application/pdf', 100), limits);
    expect(result.ok).toBe(true);
    expect(result.sourceKind).toBe('PDF');
  });

  it('accepts an EPUB whose MIME type the browser did not fill in', () => {
    // Several browsers report an empty `type` for .epub. Falling back to the
    // extension avoids rejecting a perfectly valid upload.
    const result = validateSourceFile(file('book.epub', '', 100), limits);
    expect(result.ok).toBe(true);
    expect(result.sourceKind).toBe('EPUB');
    expect(result.mimeType).toBe('application/epub+zip');
  });

  it('refuses a format the backend does not admit', () => {
    const result = validateSourceFile(file('book.mobi', 'application/x-mobipocket-ebook', 100), limits);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/PDF or EPUB/);
  });

  it('refuses an empty file', () => {
    expect(validateSourceFile(file('book.pdf', 'application/pdf', 0), limits).ok).toBe(false);
  });

  it('refuses a file above the ceiling reported by /capabilities', () => {
    const result = validateSourceFile(file('book.pdf', 'application/pdf', 2000), limits);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/larger/i);
  });

  it('accepts any size when the server reported no ceiling', () => {
    const result = validateSourceFile(file('book.pdf', 'application/pdf', 5000), {
      ...limits,
      maxBytes: null,
    });
    expect(result.ok).toBe(true);
  });
});
