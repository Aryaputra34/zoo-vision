import type { JsonSchema, Registry } from '@zoo-vision/contracts';
import { apiError } from '../common/errors';
import { splitList } from './report-query';

const typesOf = (schema: JsonSchema): string[] => {
  const t = schema.type;
  return Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : [];
};

/**
 * Whether `data.<field>` may be grouped on (`group`: a string or an enum) or aggregated
 * (`number`: a number or integer) over events of these `types`: some requested type's contract
 * must declare it that way. The single gate before a `data` field name reaches SQL.
 */
export function allowedDataField(
  registry: Registry,
  types: string[],
  field: string,
  kind: 'group' | 'number',
): boolean {
  for (const type of types) {
    for (const useCase of registry.useCases.values()) {
      if (!Object.hasOwn(useCase.events, type)) continue;
      const props = useCase.events[type].properties as
        Record<string, JsonSchema> | undefined;
      if (!props || !Object.hasOwn(props, field)) continue;
      const declared = typesOf(props[field]);
      const ok =
        kind === 'group'
          ? declared.includes('string') || Array.isArray(props[field].enum)
          : declared.includes('number') || declared.includes('integer');
      if (ok) return true;
    }
  }
  return false;
}

/** 400 FIELD_NOT_ALLOWED, with the offending request parameter as the error path. */
export function notAllowed(path: string, message: string) {
  return apiError(400, 'FIELD_NOT_ALLOWED', message, [{ path, message }]);
}

/**
 * Whether system data (`engine_started`, `camera_offline`, ...) belongs in the answer: only when
 * asked for, by `useCase=system` or by naming one of its event types or interval kinds.
 */
export function wantsSystem(
  registry: Registry,
  useCase: string | undefined,
  names: string[] | undefined,
  of: 'events' | 'intervals',
): boolean {
  if (useCase === 'system') return true;
  const declared = registry.useCases.get('system')?.[of] ?? {};
  return !!names?.some((n) => Object.hasOwn(declared, n));
}

/** At most this many `where` filters on one request. */
export const MAX_WHERE = 2;

export type DataFilter = { field: string; value: string };

/**
 * Reads `where=data.<field>:<value>,...`: each field must be a string or enum field of the
 * requested `types` (which are then required). 400 VALIDATION_FAILED for a malformed item,
 * 400 FIELD_NOT_ALLOWED for a field the contract does not offer. The value is only ever a bound
 * parameter; it may not contain a comma.
 */
export function parseWhere(
  registry: Registry,
  types: string[] | undefined,
  where: string | undefined,
): DataFilter[] {
  const items = splitList(where, '/where') ?? [];
  if (items.length > MAX_WHERE) {
    throw notAllowed('/where', `at most ${MAX_WHERE} data filters`);
  }
  return items.map((item) => {
    const colon = item.indexOf(':');
    const key = colon < 0 ? item : item.slice(0, colon);
    const value = colon < 0 ? '' : item.slice(colon + 1);
    if (!key.startsWith('data.') || key.length === 5 || value === '') {
      throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
        { path: '/where', message: `"${item}" must be data.<field>:<value>` },
      ]);
    }
    const field = key.slice(5);
    if (!types || !allowedDataField(registry, types, field, 'group')) {
      throw notAllowed(
        '/where',
        `data.${field} is not a string or enum field of the requested types (types is required)`,
      );
    }
    return { field, value };
  });
}
