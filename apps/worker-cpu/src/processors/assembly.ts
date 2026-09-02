/**
 * Phase 6 (audio assembly/mastering/packaging) — the `audio` queue's three
 * handlers, split one-file-per-concern (assembly-chapter.ts /
 * assembly-audiobook.ts / assembly-encode.ts) and re-exported here so
 * `main.ts` has a single import surface, the same way `processors/ingestion.ts`
 * is main.ts's single import surface for the `parse` queue.
 */
export {
  processAssembleChapterJob,
  type AssembleChapterCommandPayload,
  type ProcessAssembleChapterJobDeps,
} from './assembly-chapter.js';
export {
  processAssembleAudiobookJob,
  type AssembleAudiobookCommandPayload,
  type ProcessAssembleAudiobookJobDeps,
} from './assembly-audiobook.js';
export {
  processEncodeDeliveryFormatJob,
  type DeliveryFormatName,
  type EncodeDeliveryFormatCommandPayload,
  type ProcessEncodeDeliveryFormatJobDeps,
} from './assembly-encode.js';
