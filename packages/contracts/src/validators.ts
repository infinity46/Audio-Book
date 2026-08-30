import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats only ships a CJS default export; under this repo's
// moduleResolution (NodeNext) TypeScript mis-types that default import as
// the whole module namespace rather than the callable plugin (a known
// ajv-formats/TS-NodeNext interop gap). The runtime shape is fine (Node's
// CJS interop unwraps it correctly) — only the static type is wrong, so we
// import raw and assert the type we know is correct at runtime.
import addFormatsRaw from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const addFormats = addFormatsRaw as unknown as (ajv: Ajv) => Ajv;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/validators.js -> ../schemas ; src/validators.ts (ts-node/vitest) -> ../schemas
const schemasDir = path.resolve(here, '..', 'schemas');

function loadSchema(fileName: string): object {
  const raw = readFileSync(path.join(schemasDir, fileName), 'utf8');
  return JSON.parse(raw) as object;
}

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export const commandEnvelopeSchema = loadSchema('command-envelope.schema.json');
export const eventEnvelopeSchema = loadSchema('event-envelope.schema.json');

export const validateCommandEnvelope: ValidateFunction = ajv.compile(commandEnvelopeSchema);
export const validateEventEnvelope: ValidateFunction = ajv.compile(eventEnvelopeSchema);

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function runValidator(validator: ValidateFunction, data: unknown): ValidationResult {
  const valid = validator(data);
  if (valid) return { valid: true };
  return {
    valid: false,
    errors: (validator.errors ?? []).map((e) =>
      `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim(),
    ),
  };
}
