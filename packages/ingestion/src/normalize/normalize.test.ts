import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalize.js';

const cfg = { dehyphenate: true };
const cfgNoDehyphen = { dehyphenate: false };

describe('normalizeText', () => {
  it('joins a hyphenated line break for a lowercase continuation', () => {
    expect(normalizeText('extra-\nordinary', cfg)).toBe('extraordinary');
  });

  it('does not join when dehyphenation is disabled', () => {
    expect(normalizeText('extra-\nordinary', cfgNoDehyphen)).toBe('extra- ordinary');
  });

  it('preserves a real hyphen not caused by a line break', () => {
    expect(normalizeText('a well-known author', cfg)).toBe('a well-known author');
  });

  it('does not join across a capitalized word (likely not a continuation)', () => {
    expect(normalizeText('New York-\nBased company', cfg)).toBe('New York-Based company');
  });

  it('collapses runs of whitespace but preserves single spaces', () => {
    expect(normalizeText('hello    world\t\tagain', cfg)).toBe('hello world again');
  });

  it('preserves curly quotes, em dash, and ellipsis without transliteration', () => {
    const input = '“Hello,” she said — then paused… “are you there?”';
    expect(normalizeText(input, cfg)).toBe(input);
  });

  it('applies Unicode NFC normalization', () => {
    const decomposed = 'é'; // e + combining acute accent
    const composed = 'é'; // é precomposed
    expect(normalizeText(decomposed, cfg)).toBe(composed);
  });

  it('drops soft hyphens', () => {
    expect(normalizeText('con­cept', cfg)).toBe('concept');
  });

  it('is idempotent', () => {
    const inputs = [
      'extra-\nordinary   with   spaces',
      '“Quoted” text — with dashes… and\n\nnewlines',
      'well-known compound-word text',
    ];
    for (const input of inputs) {
      const once = normalizeText(input, cfg);
      const twice = normalizeText(once, cfg);
      expect(twice).toBe(once);
    }
  });
});
