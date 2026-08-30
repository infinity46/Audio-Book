/**
 * Queue job payloads are envelopes carrying identifiers only — never full
 * book/IR/binary content (event-contracts.md payload size budget: target
 * <4KB, hard ceiling 64KB). Workers use the ids here to load authoritative
 * state from PostgreSQL/object storage themselves.
 */
export interface QueueJobEnvelope<TPayload = Record<string, unknown>> {
  job_id: string;
  entity_id?: string;
  version_id?: string;
  correlation_id: string;
  causation_id?: string;
  tenant_id: string;
  payload: TPayload;
}

export const QUEUE_PAYLOAD_TARGET_BYTES = 4096;
export const QUEUE_PAYLOAD_CEILING_BYTES = 65536;

export class QueuePayloadTooLargeError extends Error {}

export function assertQueuePayloadSizeBudget(envelope: unknown): void {
  const sizeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (sizeBytes > QUEUE_PAYLOAD_CEILING_BYTES) {
    throw new QueuePayloadTooLargeError(
      `Queue job payload is ${sizeBytes} bytes, exceeding the ${QUEUE_PAYLOAD_CEILING_BYTES}-byte ceiling. ` +
        'Queue payloads must carry identifiers only (job_id, entity_id, version_id, correlation_id) — never full book/IR/binary content.',
    );
  }
}
