import { Global, Module } from '@nestjs/common';
import { EVENT_STREAM_CONFIG } from '../common/tokens.js';
import { DEFAULT_EVENT_STREAM_CONFIG, EventStreamService } from './event-stream.service.js';

/**
 * SSE fan-out (`api-specification.md` §16.19). Global because both the job
 * stream (`JobsController`) and the book stream (`ProgressController`) hang
 * off it, and the per-principal connection counter must be ONE instance per
 * process — a second instance would let a client open twice the intended
 * number of streams by alternating endpoints.
 */
@Global()
@Module({
  providers: [
    { provide: EVENT_STREAM_CONFIG, useValue: DEFAULT_EVENT_STREAM_CONFIG },
    EventStreamService,
  ],
  exports: [EventStreamService],
})
export class EventsModule {}
