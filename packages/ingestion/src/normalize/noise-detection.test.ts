import { describe, expect, it } from 'vitest';
import { detectNoise, isPageNumberLike, type PageLevelBlock } from './noise-detection.js';

function pageBlocks(count: number, headerText: string): PageLevelBlock[] {
  const blocks: PageLevelBlock[] = [];
  for (let i = 1; i <= count; i += 1) {
    blocks.push({ pageNumber: i, positionOnPage: 'first', text: headerText });
    blocks.push({ pageNumber: i, positionOnPage: 'last', text: String(i) });
  }
  return blocks;
}

describe('detectNoise', () => {
  it('flags a title repeated as a header across most pages', () => {
    const blocks = pageBlocks(6, 'THE GREAT BOOK');
    const result = detectNoise(blocks, 0.6);
    expect(result.removedTexts.has('the great book')).toBe(true);
  });

  it('flags page numbers by pattern even though the exact digits differ per page', () => {
    const blocks = pageBlocks(6, 'THE GREAT BOOK');
    const result = detectNoise(blocks, 0.6);
    expect(result.pageNumberPattern).toBe(true);
  });

  it('does not flag anything with too few pages to establish repetition', () => {
    const blocks = pageBlocks(2, 'THE GREAT BOOK');
    const result = detectNoise(blocks, 0.6);
    expect(result.removedTexts.size).toBe(0);
  });

  it('does not flag narrative text that only appears once', () => {
    const blocks: PageLevelBlock[] = [
      { pageNumber: 1, positionOnPage: 'first', text: 'It was a dark and stormy night.' },
      { pageNumber: 2, positionOnPage: 'first', text: 'The next morning was bright and clear.' },
      { pageNumber: 3, positionOnPage: 'first', text: 'By evening, the storm had returned.' },
    ];
    const result = detectNoise(blocks, 0.6);
    expect(result.removedTexts.size).toBe(0);
  });

  it('does not flag a heading that repeats below the confidence threshold', () => {
    const blocks: PageLevelBlock[] = [
      { pageNumber: 1, positionOnPage: 'first', text: 'RUNNING TITLE' },
      { pageNumber: 2, positionOnPage: 'first', text: 'Something else entirely' },
      { pageNumber: 3, positionOnPage: 'first', text: 'And something different again' },
    ];
    const result = detectNoise(blocks, 0.6);
    expect(result.removedTexts.has('running title')).toBe(false);
  });
});

describe('isPageNumberLike', () => {
  it.each(['1', '42', 'Page 7', 'iv', 'XII'])('treats "%s" as page-number-like', (text) => {
    expect(isPageNumberLike(text)).toBe(true);
  });

  it.each(['Chapter 1', 'The year 1999', 'a normal sentence.'])(
    'does not treat "%s" as page-number-like',
    (text) => {
      expect(isPageNumberLike(text)).toBe(false);
    },
  );
});
