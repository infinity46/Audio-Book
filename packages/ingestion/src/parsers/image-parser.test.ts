import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImageParser } from './image-parser.js';
import { TesseractOcrProvider } from '../ocr/tesseract-ocr-provider.js';
import { UnavailableOcrProvider } from '../ocr/ocr-provider.js';
import { defaultIngestionConfig } from '../config.js';
import { FileTooLargeError } from '../errors.js';
import {
  buildCorruptedImage,
  buildImageWithText,
  renderTextImage,
} from '../test-fixtures/build-fixtures.js';

const parser = new ImageParser();
const config = defaultIngestionConfig();

describe('ImageParser (no OCR provider configured)', () => {
  it('flags the page NEEDS_REVIEW/OCR_UNAVAILABLE rather than fabricating content', async () => {
    const buffer = buildImageWithText('Some scanned text');
    const document = await parser.parse({
      buffer,
      declaredMimeType: 'image/png',
      config,
      ocrProvider: new UnavailableOcrProvider(),
    });
    expect(document.pages).toHaveLength(1);
    expect(document.pages![0]).toMatchObject({
      status: 'NEEDS_REVIEW',
      failureReasonCode: 'OCR_UNAVAILABLE',
    });
    expect(document.blocks).toHaveLength(0);
  });

  it('rejects a corrupted image', async () => {
    const buffer = buildCorruptedImage();
    await expect(
      parser.parse({
        buffer,
        declaredMimeType: 'image/png',
        config,
        ocrProvider: new UnavailableOcrProvider(),
      }),
    ).rejects.toThrow();
  });

  it('rejects an image exceeding the configured pixel dimension limit', async () => {
    const buffer = renderTextImage('irrelevant', 100, 100, 10);
    await expect(
      parser.parse({
        buffer,
        declaredMimeType: 'image/png',
        config: { ...config, maxImageDimensionPx: 10 },
        ocrProvider: new UnavailableOcrProvider(),
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('ImageParser (real OCR provider)', () => {
  let ocrProvider: TesseractOcrProvider;

  beforeAll(() => {
    ocrProvider = new TesseractOcrProvider({ language: 'eng' });
  });

  afterAll(async () => {
    await ocrProvider.terminate();
  });

  it('extracts OCR-recognized text as a paragraph block', async () => {
    const buffer = buildImageWithText('Chapter One of a scanned book.');
    const document = await parser.parse({
      buffer,
      declaredMimeType: 'image/png',
      config,
      ocrProvider,
    });

    expect(document.sourceKind).toBe('IMAGE_SET');
    expect(document.pages![0]!.status).toBe('OK');
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]!.text).toContain('Chapter One');
    expect(document.blocks[0]!.locator).toMatchObject({ kind: 'image', imageIndex: 0 });
  }, 30_000);
});
