import type { JsonSchema, Registry } from '@zoo-vision/contracts';

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
