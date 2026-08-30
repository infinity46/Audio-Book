import { uuidv7 } from 'uuidv7';

/**
 * All identifiers (message_id, event_id, job_id, correlation_id,
 * causation_id, and every entity primary key) are UUIDv7, generated
 * application-side — never a DB default (database-schema.md §3/§4, confirmed
 * by architecture-review.md ADR on ID conventions).
 */
export function generateId(): string {
  return uuidv7();
}
