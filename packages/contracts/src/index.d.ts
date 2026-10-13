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
  validateSettings(useCase: string, settings: unknown): ValidationResult;
  /** Deep clone of `settings` with schema defaults filled in. */
  withDefaults(useCase: string, settings: object): object;
  restrictedFields(useCase: string): { path: string; minRole: 'MANAGER' | 'SUPERADMIN' }[];
  /** Use cases that have settings, sorted. */
  assignableUseCases(): string[];
}

/** Default directory: ../generated/schemas */
export function loadRegistry(dir?: string): Registry;
export function createValidator(registry?: Registry): Validator;
