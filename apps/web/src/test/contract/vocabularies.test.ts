/**
 * @vitest-environment node
 *
 * Enum drift (Phase 9 rules 164, 165).
 *
 * The frontend hard-codes a handful of closed vocabularies so a picker can be
 * rendered before `/capabilities` resolves. Hard-coding is only safe if drift
 * is a *test failure* rather than a silently wrong dropdown — so these read the
 * API's own JSON Schemas from `packages/contracts/schemas` and compare.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_CHUNK_STATUSES,
  DELIVERY_MODES,
  EMOTIONS,
  SPEAKER_TYPES,
} from '@/lib/vocabularies';
import { REVIEW_FLAGS } from '@/lib/api/types';

const SCHEMA_DIR = fileURLToPath(new URL('../../../../../packages/contracts/schemas/', import.meta.url));

/**
 * A JSON Schema, typed loosely enough to walk but tightly enough that every
 * access below is checked. `unknown` everywhere would need a cast per line;
 * this is the narrowest shape that reads naturally.
 */
interface JsonSchema {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
}

function schema(name: string): JsonSchema {
  return JSON.parse(readFileSync(`${SCHEMA_DIR}${name}`, 'utf8')) as JsonSchema;
}

/** Walks a dotted path of `properties` keys, failing loudly if it is wrong. */
function at(root: JsonSchema, path: string): JsonSchema {
  let node: JsonSchema = root;
  for (const key of path.split('.')) {
    const next = node.properties?.[key];
    if (!next) throw new Error(`Schema path not found: ${path} (at ${key})`);
    node = next;
  }
  return node;
}

const chunkSchema = schema('update-audio-script-chunk.schema.json');
const ttsSchema = schema('start-tts.schema.json');
const assemblySchema = schema('start-assembly.schema.json');

describe('closed vocabularies match the API schemas', () => {
  it('emotion', () => {
    expect([...EMOTIONS]).toEqual(at(chunkSchema, 'performance.emotion').enum);
  });

  it('delivery mode', () => {
    expect([...DELIVERY_MODES]).toEqual(
      at(chunkSchema, 'performance.delivery_mode').enum,
    );
  });

  it('speaker type', () => {
    expect([...SPEAKER_TYPES]).toEqual(
      at(chunkSchema, 'performance.speaker_type').enum,
    );
  });

  it('review flags', () => {
    expect([...REVIEW_FLAGS].sort()).toEqual(
      [...at(chunkSchema, 'quality.review_flags').items?.enum ?? []].sort(),
    );
  });

  it('audio chunk status', () => {
    expect([...AUDIO_CHUNK_STATUSES]).toEqual(
      at(ttsSchema, 'filter.audio_chunk_status').items?.enum ?? [],
    );
  });
});

describe('request bodies the studio sends are accepted by the schemas', () => {
  it('the TTS scopes the generation and review screens use exist', () => {
    const scopes = at(ttsSchema, 'scope').enum ?? [];
    expect(scopes).toContain('BOOK');
    expect(scopes).toContain('CHUNKS');
  });

  it('the assembly scope the generation screen uses exists', () => {
    expect(at(assemblySchema, 'scope').enum ?? []).toContain('AUDIOBOOK');
  });

  it('the delivery formats the settings screen offers are the schema’s own', () => {
    // The picker reads /capabilities at runtime; this asserts the fallback and
    // the schema agree, so an unavailable capabilities read cannot offer a
    // format the API would reject.
    expect(at(assemblySchema, 'delivery_formats').items?.enum).toEqual([
      'M4B',
      'M4A',
      'MP3_PER_CHAPTER',
    ]);
  });

  it('rejects unknown fields, which is why the studio sends no extras', () => {
    // §2.9 strict mode: an unrecognized field is 422 unknown_field, never
    // silently dropped. Every body the studio builds is field-exact.
    expect(ttsSchema.additionalProperties).toBe(false);
    expect(assemblySchema.additionalProperties).toBe(false);
    expect(chunkSchema.additionalProperties).toBe(false);
  });

  it('ingestion accepts book_file_id and nothing scope-shaped', () => {
    // The studio must not send `scope` to POST .../ingestion — it would be 422.
    const ingestion = schema('request-ingestion.schema.json');
    expect(Object.keys(ingestion.properties ?? {})).toEqual(['book_file_id', 'force', 'priority']);
  });

  it('analysis requires a mode, which the studio always supplies', () => {
    const analysis = schema('start-analysis.schema.json');
    expect(analysis.required).toContain('mode');
    expect(at(analysis, 'mode').enum).toEqual(['INCREMENTAL', 'REBUILD']);
  });

  it('a voice version cannot be created without a consent attestation', () => {
    // A product guarantee the schema enforces; the UI must not undercut it.
    const version = schema('create-voice-profile-version.schema.json');
    expect(version.required).toContain('reference_audio_consent');
    expect(at(version, 'reference_audio_consent.subject').enum).toEqual([
      'SYNTHETIC',
      'SELF',
      'THIRD_PARTY_CONSENTED',
    ]);
  });

  it('book status is not patchable, so the studio renders no control for it', () => {
    const updateBook = schema('update-book.schema.json');
    expect(Object.keys(updateBook.properties ?? {})).not.toContain('status');
  });

  it('a user cannot change their own email or roles here', () => {
    const updateUser = schema('update-current-user.schema.json');
    expect(Object.keys(updateUser.properties ?? {})).not.toContain('email');
    expect(Object.keys(updateUser.properties ?? {})).not.toContain('roles');
  });
});
