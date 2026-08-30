import { describe, expect, it } from 'vitest';
import {
  assertQueuePayloadSizeBudget,
  QueuePayloadTooLargeError,
  type QueueJobEnvelope,
} from './job-payload.js';

describe('assertQueuePayloadSizeBudget', () => {
  it('allows small identifier-only envelopes', () => {
    const envelope: QueueJobEnvelope = {
      job_id: 'job-1',
      entity_id: 'book-1',
      correlation_id: 'corr-1',
      tenant_id: 'tenant-1',
      payload: { version_id: 'v1' },
    };
    expect(() => assertQueuePayloadSizeBudget(envelope)).not.toThrow();
  });

  it('rejects a payload that smuggles bulk content past the ceiling', () => {
    const envelope: QueueJobEnvelope = {
      job_id: 'job-1',
      correlation_id: 'corr-1',
      tenant_id: 'tenant-1',
      payload: { fullBookText: 'x'.repeat(100_000) },
    };
    expect(() => assertQueuePayloadSizeBudget(envelope)).toThrow(QueuePayloadTooLargeError);
  });
});
