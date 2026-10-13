export * from '../generated/ts/index';

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

export type JsonSchema = Record<string, unknown>;

export interface UseCaseContract {
  label: string;
  schemaVersion: number;
  /** null when the use case cannot be assigned to a camera (system). */
  settings: JsonSchema | null;
  /** event type -> schema */
  events: Record<string, JsonSchema>;
  /** interval kind -> schema */
  intervals: Record<string, JsonSchema>;
  /** metric name -> { label, unit } */
  metrics: Record<string, { label: string; unit: string }>;
}

export interface Registry {
  envelope: JsonSchema;
  useCases: Map<string, UseCaseContract>;
}

export interface Validator {
  validateMessage(message: unknown): ValidationResult;
  /** Also reports duplicate ids in every `polygon-list`, at each concrete match of a `*` path. */
  validateSettings(useCase: string, settings: unknown): ValidationResult;
  /** Deep clone of `settings` with schema defaults filled in. */
  withDefaults(useCase: string, settings: object): object;
  /**
   * Settings paths with an `x-minRole`. The schema walk follows `properties`, `items`, `prefixItems`, `anyOf`,
   * `oneOf` and `allOf`; any array index is written as a `*` segment, so the `sensitivity` of every item of `zones` is the path `/zones/` + `*` + `/sensitivity`.
   */
  restrictedFields(useCase: string): { path: string; minRole: 'MANAGER' | 'SUPERADMIN' }[];
  /** Use cases that have settings, sorted. */
  assignableUseCases(): string[];
}

/** Calls `visit(schemaNode, pointer)` for every node of a settings schema; array indexes in `pointer` are `*`. */
export function walkSchema(schema: JsonSchema, visit: (node: JsonSchema, pointer: string) => void): void;
/** Default directory: ../generated/schemas */
export function loadRegistry(dir?: string): Registry;
export function createValidator(registry?: Registry): Validator;
