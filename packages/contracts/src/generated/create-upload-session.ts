/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

export interface CreateUploadSession {
  file_name: string;
  declared_mime_type: string;
  declared_size_bytes: number;
  declared_content_hash: {
    algorithm: 'SHA256';
    value: string;
  };
  source_kind: 'PDF' | 'EPUB';
}
