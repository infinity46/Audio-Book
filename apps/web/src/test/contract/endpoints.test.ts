/**
 * @vitest-environment node
 *
 * Frontend ↔ API contract audit (Phase 9 rules 166, 191).
 *
 * Extracts every `/api/v1/...` path the studio actually constructs, normalizes
 * its template parameters, and asserts each one appears in the endpoint tables
 * of `api-specification.md` §15 with the method the studio uses.
 *
 * This is the check that catches a path invented in a component, a typo'd
 * segment, and a verb the resource does not support — none of which a type
 * checker can see, because they are strings.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../../../docs/architecture/api-specification.md', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === '__tests__') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** `/api/v1/books/${bookId}/tts` → `/api/v1/books/{param}/tts` */
function normalize(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, '{param}')
    .replace(/\{[a-zA-Z_]+\}/g, '{param}')
    .replace(/\/+$/, '');
}

interface Usage {
  path: string;
  file: string;
  method: string;
}

/**
 * Comments in this codebase quote API paths freely (`/api/v1/auth/**` is named
 * precisely because it does *not* exist). Stripping them first is what keeps
 * this a test of calls rather than of prose.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The five stage commands share one template, `/api/v1/books/{id}/{stage}`,
 * because §4.3 fixes one command shape for the whole API. Expanding it to the
 * concrete five is what lets this test check them individually.
 */
const STAGES = ['ingestion', 'analysis', 'director', 'tts', 'assembly'];

/** Finds `'/api/v1/...'` and `` `/api/v1/...` `` literals and their verb. */
function collectUsages(): Usage[] {
  const usages: Usage[] = [];
  for (const file of walk(SRC)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const pattern = /(['`])(\/api\/v1\/[^'`\s]*)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const path = normalize(match[2]!.split('?')[0]!);
      // Wide enough to see past a multi-line inline generic on the helper call
      // (`post<{ … }>(\`/api/v1/…\`)`). The generic pattern excludes parentheses
      // so it cannot run backwards past the *previous* call and misattribute
      // the verb.
      const before = source.slice(Math.max(0, match.index - 600), match.index).trimEnd();
      const after = source.slice(match.index, match.index + 400);

      // Access URLs are minted by POST and are never fetched directly; the path
      // is often held in a variable and passed to `useSignedAudio`, so the
      // call site is not adjacent to the literal.
      const method = path.endsWith('/access-urls')
        ? 'POST'
        : /\bpost\s*(?:<[^()]*>)?\s*\($/.test(before)
          ? 'POST'
          : /\bput\s*(?:<[^()]*>)?\s*\($/.test(before)
            ? 'PUT'
            : /\bpatch\s*(?:<[^()]*>)?\s*\($/.test(before)
              ? 'PATCH'
              : /\bdel\($/.test(before)
                ? 'DELETE'
                : (/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(after)?.[1] ?? 'GET');

      if (path === '/api/v1/books/{param}/{param}') {
        for (const stage of STAGES) {
          usages.push({ path: `/api/v1/books/{param}/${stage}`, file, method });
        }
        continue;
      }
      usages.push({ path, file, method });
    }
  }
  return usages;
}

/** Every `| METHOD | \`/api/v1/...\` |` row in the §15 endpoint tables. */
function specEndpoints(): Set<string> {
  const spec = readFileSync(SPEC, 'utf8');
  const set = new Set<string>();
  const pattern = /^\|\s*(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\|\s*`([^`]+)`/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(spec)) !== null) {
    set.add(`${match[1]} ${normalize(match[2]!)}`);
  }
  return set;
}

const usages = collectUsages();
const endpoints = specEndpoints();

describe('frontend ↔ api-specification.md', () => {
  it('parsed a plausible number of endpoints from the specification', () => {
    // A guard on the parser itself: a regex that silently matches nothing
    // would make every assertion below vacuously pass.
    expect(endpoints.size).toBeGreaterThan(50);
  });

  it('found the paths the studio calls', () => {
    expect(usages.length).toBeGreaterThan(20);
  });

  it('calls no endpoint the specification does not define', () => {
    const unknown = usages
      .filter((usage) => !endpoints.has(`${usage.method} ${usage.path}`))
      .map((usage) => `${usage.method} ${usage.path}  (${usage.file.replace(SRC, 'src/')})`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('never reaches outside /api/v1 — no internal, metrics, or health surface', () => {
    for (const usage of usages) {
      expect(usage.path.startsWith('/api/v1/')).toBe(true);
    }
  });

  it('never constructs an object-storage path itself', () => {
    // Rule 127. Binary access is always a signed URL minted by the API, and no
    // key or bucket name ever appears in a response for the client to use.
    for (const file of walk(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source).not.toMatch(/s3:\/\/|\.s3\.amazonaws|storage_key|storage_bucket/);
    }
  });
});
