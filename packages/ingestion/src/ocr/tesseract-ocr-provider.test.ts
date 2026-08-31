import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TesseractOcrProvider } from './tesseract-ocr-provider.js';
import { renderTextImage } from '../test-fixtures/build-fixtures.js';

describe('TesseractOcrProvider', () => {
  let provider: TesseractOcrProvider;

  beforeAll(() => {
    provider = new TesseractOcrProvider({ language: 'eng' });
  });

  afterAll(async () => {
    await provider.terminate();
  });

  it('reports a non-null identity, unlike UnavailableOcrProvider', () => {
    expect(provider.identity).not.toBeNull();
    expect(provider.identity.providerId).toBe('tesseract.js');
  });

  it('recognizes clear rendered text with high confidence', async () => {
    const image = renderTextImage('Hello scanned world');
    const result = await provider.ocrPage({ image, language: 'eng', pageNumber: 1 });

    expect(result.text.trim()).toBe('Hello scanned world');
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.engine).toBe('tesseract');
    expect(result.language).toBe('eng');
  }, 30_000);

  it('returns near-empty text for a blank image rather than throwing', async () => {
    const blank = renderTextImage('', 200, 100, 10);
    const result = await provider.ocrPage({ image: blank, language: 'eng', pageNumber: 1 });
    expect(result.text.trim()).toBe('');
  }, 30_000);
});
