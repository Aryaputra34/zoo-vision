import { isDeepStrictEqual } from 'node:util';

export type JsonChange = { path: string; before?: unknown; after?: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Differences between two JSON values as JSON pointers, sorted. Plain objects are compared key
 * by key; arrays and scalars as whole values. A side that is missing is omitted.
 */
export function diffJson(before: unknown, after: unknown): JsonChange[] {
  const out: JsonChange[] = [];
  walk(before, after, '', out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  out: JsonChange[],
): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const p = `${path}/${escape(key)}`;
      const inBefore = key in before;
      const inAfter = key in after;
      if (inBefore && inAfter) walk(before[key], after[key], p, out);
      else if (inBefore) out.push({ path: p, before: before[key] });
      else out.push({ path: p, after: after[key] });
    }
    return;
  }
  if (!isDeepStrictEqual(before, after)) out.push({ path, before, after });
}
