#!/usr/bin/env tsx
/**
 * JSON Schema -> TypeScript codegen. JSON Schema (schemas/*.schema.json) is
 * the single cross-language source of truth (context.md §23 row 26); this
 * script produces the TS side of that, checked into src/generated/ so CI can
 * detect drift by regenerating and diffing (see tests/contract for the
 * corresponding Ajv-validation contract tests, and python/workers-common's
 * generate step for the Pydantic side).
 *
 * Run: pnpm --filter @audio-book/contracts run generate
 */
import { compile } from 'json-schema-to-typescript';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, '..', 'schemas');
const outDir = path.resolve(here, '..', 'src', 'generated');

const BANNER = `/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/contracts/schemas/*.schema.json
 * Regenerate: pnpm --filter @audio-book/contracts run generate
 */

`;

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const files = (await readdir(schemasDir)).filter((f) => f.endsWith('.schema.json'));

  const generatedNames: string[] = [];
  for (const file of files) {
    const schemaPath = path.join(schemasDir, file);
    const raw = await readFile(schemaPath, 'utf8');
    const schema = JSON.parse(raw) as Record<string, unknown>;
    const typeName =
      typeof schema.title === 'string' ? schema.title : path.basename(file, '.schema.json');
    const ts = await compile(schema, typeName, {
      bannerComment: '',
      additionalProperties: false,
      style: { singleQuote: true },
    });
    const outFile = path.join(outDir, `${path.basename(file, '.schema.json')}.ts`);
    await writeFile(outFile, BANNER + ts, 'utf8');
    generatedNames.push(path.basename(file, '.schema.json'));
    console.log(`generated ${path.relative(process.cwd(), outFile)}`);
  }

  const indexContent =
    BANNER + generatedNames.map((n) => `export * from './${n}.js';`).join('\n') + '\n';
  await writeFile(path.join(outDir, 'index.ts'), indexContent, 'utf8');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
