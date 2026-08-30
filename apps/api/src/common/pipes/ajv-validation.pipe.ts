import { Injectable, type PipeTransform } from '@nestjs/common';
import { Ajv, type ValidateFunction } from 'ajv';
// See packages/contracts/src/validators.ts for why this is a raw import + cast.
import addFormatsRaw from 'ajv-formats';
import { ValidationError } from '@audio-book/errors';

const addFormats = addFormatsRaw as unknown as (ajv: Ajv) => Ajv;

const ajv = new Ajv({ allErrors: true, strict: true, removeAdditional: false, coerceTypes: false });
addFormats(ajv);

/**
 * Request validation driven by the same JSON Schema convention as the rest
 * of the contract strategy (packages/contracts) — strict mode: unknown
 * fields rejected (never silently dropped), no type coercion
 * (api-specification.md §12.1: `"5"` !== `5`).
 */
@Injectable()
export class AjvValidationPipe implements PipeTransform {
  private readonly validator: ValidateFunction;

  constructor(schema: object) {
    this.validator = ajv.compile({ ...schema, additionalProperties: false });
  }

  transform(value: unknown): unknown {
    const valid = this.validator(value);
    if (!valid) {
      const details = (this.validator.errors ?? []).map((e) => ({
        field: e.instancePath.replace(/^\//, '').replace(/\//g, '.') || undefined,
        issue: ajvKeywordToIssue(e.keyword),
      }));
      throw new ValidationError({ message: 'Request validation failed.', details });
    }
    return value;
  }
}

/** Maps Ajv keyword failures onto the closed `issue` vocabulary from api-specification.md §12.1. */
function ajvKeywordToIssue(keyword: string): string {
  switch (keyword) {
    case 'required':
      return 'required';
    case 'additionalProperties':
      return 'unknown_field';
    case 'type':
      return 'invalid_type';
    case 'enum':
      return 'invalid_enum';
    case 'format':
    case 'pattern':
      return 'invalid_format';
    case 'maxLength':
      return 'too_long';
    case 'minLength':
      return 'too_short';
    case 'minimum':
    case 'maximum':
      return 'out_of_range';
    default:
      return 'invalid_type';
  }
}
