import { isDeepStrictEqual } from 'node:util';
import type { Validator } from '@zoo-vision/contracts';
import { roleAtLeast } from '../auth/actor';
import type { Role } from '../generated/prisma/enums';

/** RFC 6901 lookup; a missing key anywhere on the way yields undefined. */
function pointerGet(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const raw of pointer.split('/').slice(1)) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The restricted settings paths (x-minRole) whose values differ between `before` and `after`
 * (schema defaults filled in on both sides) and that `role` may not change.
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
  return fields
    .filter(
      (f) => !isDeepStrictEqual(pointerGet(b, f.path), pointerGet(a, f.path)),
    )
    .map((f) => f.path);
}
