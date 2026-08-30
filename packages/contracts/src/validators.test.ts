import { describe, expect, it } from 'vitest';
import { runValidator, validateCommandEnvelope, validateEventEnvelope } from './validators.js';

const validEvent = {
  event_id: '018f4e1a-0000-7000-8000-000000000001',
  event_type: 'book.uploaded',
  schema_version: '1.0',
  occurred_at: '2026-01-01T00:00:00.000Z',
  correlation_id: '018f4e1a-0000-7000-8000-000000000002',
  causation_id: '018f4e1a-0000-7000-8000-000000000003',
  tenant_id: '018f4e1a-0000-7000-8000-000000000004',
  producer: 'api',
  producer_version: '1.0.0',
  payload: {},
};

describe('event envelope schema', () => {
  it('accepts a valid envelope', () => {
    expect(runValidator(validateEventEnvelope, validEvent).valid).toBe(true);
  });

  it('rejects an unknown event_type (the 36 names are closed)', () => {
    const result = runValidator(validateEventEnvelope, { ...validEvent, event_type: 'made.up' });
    expect(result.valid).toBe(false);
  });

  it('rejects unknown fields (strict/closed envelope)', () => {
    const result = runValidator(validateEventEnvelope, { ...validEvent, extra_field: 'nope' });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { correlation_id: _omit, ...rest } = validEvent;
    expect(runValidator(validateEventEnvelope, rest).valid).toBe(false);
  });
});

describe('command envelope schema', () => {
  const validCommand = {
    message_id: '018f4e1a-0000-7000-8000-000000000010',
    message_type: 'parse_book',
    schema_version: '1.0',
    enqueued_at: '2026-01-01T00:00:00.000Z',
    correlation_id: '018f4e1a-0000-7000-8000-000000000011',
    causation_id: '018f4e1a-0000-7000-8000-000000000012',
    tenant_id: '018f4e1a-0000-7000-8000-000000000013',
    job_id: '018f4e1a-0000-7000-8000-000000000014',
    attempt: 1,
    lease_fence: 1,
    idempotency_key: 'idem-1',
    priority: 'NORMAL',
    producer: 'api',
    producer_version: '1.0.0',
    payload: {},
  };

  it('accepts a valid command envelope', () => {
    expect(runValidator(validateCommandEnvelope, validCommand).valid).toBe(true);
  });

  it('rejects an invalid priority value', () => {
    const result = runValidator(validateCommandEnvelope, { ...validCommand, priority: 'URGENT' });
    expect(result.valid).toBe(false);
  });
});
