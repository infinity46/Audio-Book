import { describe, expect, it } from 'vitest';
import { buildCommandEnvelope, buildEventEnvelope, nextAttemptEnvelope } from './envelope.js';

describe('buildEventEnvelope', () => {
  it('mints a fresh event_id each call', () => {
    const base = {
      eventType: 'book.uploaded' as const,
      schemaVersion: '1.0',
      tenantId: 't1',
      correlationId: 'c1',
      causationId: 'm1',
      producer: 'api',
      producerVersion: '1.0.0',
      payload: {},
    };
    const a = buildEventEnvelope(base);
    const b = buildEventEnvelope(base);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.correlation_id).toBe('c1');
  });
});

describe('command envelope retry semantics', () => {
  it('nextAttemptEnvelope keeps job_id/correlation_id but mints a new message_id and increments attempt', () => {
    const first = buildCommandEnvelope({
      messageType: 'parse_book',
      schemaVersion: '1.0',
      tenantId: 't1',
      correlationId: 'c1',
      causationId: 'req-1',
      jobId: 'job-1',
      attempt: 1,
      leaseFence: 1,
      idempotencyKey: 'idem-1',
      priority: 'NORMAL',
      producer: 'api',
      producerVersion: '1.0.0',
      payload: {},
    });

    const retry = nextAttemptEnvelope(first, 2);

    expect(retry.job_id).toBe(first.job_id);
    expect(retry.correlation_id).toBe(first.correlation_id);
    expect(retry.message_id).not.toBe(first.message_id);
    expect(retry.attempt).toBe(2);
    expect(retry.lease_fence).toBe(2);
  });
});
