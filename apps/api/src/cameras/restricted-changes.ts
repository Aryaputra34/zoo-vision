import { isDeepStrictEqual } from 'node:util';
import type { Validator } from '@zoo-vision/contracts';
import { roleAtLeast } from '../auth/actor';
import type { Role } from '../generated/prisma/enums';

const unescape = (segment: string) =>
  segment.replace(/~1/g, '/').replace(/~0/g, '~');

/** One step down an object by pointer segment; anything else yields undefined. */
function child(doc: unknown, segment: string): unknown {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return undefined;
  return (doc as Record<string, unknown>)[unescape(segment)];
}

/** The concrete pointers under `doc` that the segments reach and where a value is defined. */
function definedPaths(doc: unknown, segments: string[], at: string): string[] {
  if (segments.length === 0) return doc === undefined ? [] : [at];
  const [head, ...rest] = segments;
  if (head === '*') {
    return Array.isArray(doc)
      ? doc.flatMap((item, i) => definedPaths(item, rest, `${at}/${i}`))
      : [];
  }
  return definedPaths(child(doc, head), rest, `${at}/${head}`);
}

const idOf = (item: unknown): string | undefined => {
  const id = child(item, 'id');
  return typeof id === 'string' ? id : undefined;
};

/** For each item of `after`, the index of its counterpart in `before` (-1: none). By id when all items have one. */
function matchItems(before: unknown[], after: unknown[]): number[] {
  const ids = [...before, ...after].map(idOf);
  if (ids.every((id) => id !== undefined)) {
    return after.map((item) => before.findIndex((b) => idOf(b) === idOf(item)));
  }
  return after.map((_, i) => (i < before.length ? i : -1));
}

/**
 * Collects the restricted pointers under `segments` that changed. `before` and `after` have their defaults
 * filled in; `raw` is `after` as sent, to tell an added item that sets the field from one that leaves it out.
 */
function collect(
  before: unknown,
  after: unknown,
  raw: unknown,
  segments: string[],
  at: string,
  out: Set<string>,
): void {
  if (segments.length === 0) {
    if (!isDeepStrictEqual(before, after)) out.add(at);
    return;
  }
  const [head, ...rest] = segments;
  if (head !== '*') {
    collect(
      child(before, head),
      child(after, head),
      child(raw, head),
      rest,
      `${at}/${head}`,
      out,
    );
    return;
  }
  if (!Array.isArray(after)) return;
  const beforeItems = Array.isArray(before) ? before : [];
  const rawItems = Array.isArray(raw) ? raw : [];
  const matches = matchItems(beforeItems, after);
  after.forEach((item, i) => {
    const path = `${at}/${i}`;
    if (matches[i] >= 0) {
      collect(beforeItems[matches[i]], item, rawItems[i], rest, path, out);
    } else {
      definedPaths(rawItems[i], rest, path).forEach((p) => out.add(p));
    }
  });
}

/**
 * The concrete restricted settings pointers (x-minRole) whose values differ between `before` and `after`
 * (schema defaults filled in on both sides) and that `role` may not change. A restricted path with a `*`
 * segment is reported once per array item: items are matched by their string `id` when every item on both
 * sides has one, otherwise by index. An added item violates only where it sets the restricted value itself;
 * a removed item is not a change.
 */
export function restrictedChanges(
  validator: Validator,
  useCase: string,
  before: object | null,
  after: object,
  role: Role,
): string[] {
  const fields = validator
    .restrictedFields(useCase)
    .filter((f) => !roleAtLeast(role, f.minRole));
  if (fields.length === 0) return [];
  const b = validator.withDefaults(useCase, before ?? {});
  const a = validator.withDefaults(useCase, after);
  const out = new Set<string>();
  for (const f of fields)
    collect(b, a, after, f.path.split('/').slice(1), '', out);
  return [...out];
}
