import { describe, expect, it } from 'vitest';
import { redactSensitiveFields } from './redaction.js';

describe('redactSensitiveFields', () => {
  it('redacts book text, prompts, and embeddings at any depth', () => {
    const result = redactSensitiveFields({
      job_id: 'abc',
      context: {
        prompt: 'Once upon a time...',
        chunk: { spoken_text: 'Hello there.', embedding: [0.1, 0.2] },
      },
    });
    expect(result).toEqual({
      job_id: 'abc',
      context: {
        prompt: '[REDACTED]',
        chunk: { spoken_text: '[REDACTED]', embedding: '[REDACTED]' },
      },
    });
  });

  it('leaves ordinary fields untouched', () => {
    const result = redactSensitiveFields({ job_id: 'abc', status: 'RUNNING', attempt: 2 });
    expect(result).toEqual({ job_id: 'abc', status: 'RUNNING', attempt: 2 });
  });
});
