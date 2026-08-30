import { describe, expect, it } from 'vitest';
import { ValidationError } from '@audio-book/errors';
import { AjvValidationPipe } from './ajv-validation.pipe.js';

const schema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
  },
};

describe('AjvValidationPipe', () => {
  it('passes valid input through unchanged', () => {
    const pipe = new AjvValidationPipe(schema);
    expect(pipe.transform({ title: 'hello' })).toEqual({ title: 'hello' });
  });

  it('rejects missing required fields with the closed issue vocabulary', () => {
    const pipe = new AjvValidationPipe(schema);
    try {
      pipe.transform({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.[0]?.issue).toBe('required');
    }
  });

  it('rejects unknown fields (strict mode, no silent drop)', () => {
    const pipe = new AjvValidationPipe(schema);
    expect(() => pipe.transform({ title: 'hello', extra: true })).toThrow(ValidationError);
  });

  it('does not coerce types', () => {
    const pipe = new AjvValidationPipe(schema);
    expect(() => pipe.transform({ title: 123 })).toThrow(ValidationError);
  });
});
