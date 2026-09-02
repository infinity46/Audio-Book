/**
 * `audiobook_rendition.status` (`prisma/schema.prisma`'s `AudiobookRendition`
 * model) is a raw `TEXT` column — the schema names no DB enum for it
 * (`database-schema.md` §16.7 lists a `status` column but names no enum
 * type). This union is the single agreed value set, shared by every
 * assembly handler that reads or writes it, so "READY" vs "ready" typos
 * can't silently create a fourth status.
 */
export type AudiobookRenditionStatus = 'PENDING' | 'ENCODING' | 'READY' | 'FAILED';
