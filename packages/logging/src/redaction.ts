/**
 * Field names that must never reach a log line, anywhere in a logged object
 * graph, at any depth: full book text, prompts built from book content, and
 * embeddings. Matching is by key name (case-insensitive), not by path, since
 * these can legitimately appear at many different nesting levels across
 * services. This is a denylist, not a substitute for callers simply not
 * logging book content in the first place.
 */
const FORBIDDEN_KEY_PATTERN =
  /(book[_-]?text|full[_-]?text|raw[_-]?text|prompt|embedding|paragraph[_-]?content|canonical[_-]?text|spoken[_-]?text)/i;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

export function redactSensitiveFields<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value as unknown[];
    return items.map((item) => redactSensitiveFields(item, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactSensitiveFields(val, depth + 1);
    }
  }
  return out as T;
}
