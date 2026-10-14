import type { Registry } from '@zoo-vision/contracts';

const EVENT_BASE = [
  'time_local',
  'event_id',
  'camera_id',
  'camera_name',
  'use_case',
  'type',
  'severity',
  'config_version',
];

export const INTERVAL_COLUMNS = [
  'start_local',
  'end_local',
  'duration_sec',
  'interval_id',
  'camera_id',
  'camera_name',
  'use_case',
  'kind',
  'subject_id',
  'end_reason',
  'data',
];

export const METRIC_COLUMNS = [
  'minute_local',
  'camera_id',
  'camera_name',
  'use_case',
  'name',
  'value',
];

/**
 * The `data` properties (sorted) that the event schemas matching the filter declare, one column
 * each; null without a `useCase` or `types` filter, where `data` is one JSON column instead.
 * Known before the first row, so the header can be sent at once.
 */
export function dataFields(
  registry: Registry,
  useCase?: string,
  types?: string[],
): string[] | null {
  if (!useCase && !types?.length) return null;
  const fields = new Set<string>();
  for (const [id, contract] of registry.useCases) {
    if (useCase && id !== useCase) continue;
    for (const [type, schema] of Object.entries(contract.events)) {
      if (types?.length && !types.includes(type)) continue;
      const props = schema.properties as Record<string, unknown> | undefined;
      for (const field of Object.keys(props ?? {})) fields.add(field);
    }
  }
  return [...fields].sort();
}

/** The header of events.csv. */
export function eventColumns(
  registry: Registry,
  useCase?: string,
  types?: string[],
): string[] {
  const fields = dataFields(registry, useCase, types);
  return [
    ...EVENT_BASE,
    ...(fields ? fields.map((f) => `data.${f}`) : ['data']),
    'snapshot_url',
  ];
}

const sorted = (values: Set<string>) => [...values].sort();

/**
 * The header of summary.csv: the four keys, then per event type of the use cases in scope a
 * count, per interval kind the seconds, per metric the average and the maximum. Without a
 * `useCase` the scope is every use case but `system`.
 */
export function summaryColumns(registry: Registry, useCase?: string): string[] {
  const types = new Set<string>();
  const kinds = new Set<string>();
  const names = new Set<string>();
  for (const [id, contract] of registry.useCases) {
    if (useCase ? id !== useCase : id === 'system') continue;
    for (const t of Object.keys(contract.events)) types.add(t);
    for (const k of Object.keys(contract.intervals)) kinds.add(k);
    for (const n of Object.keys(contract.metrics)) names.add(n);
  }
  return [
    'bucket_local',
    'camera_id',
    'camera_name',
    'use_case',
    ...sorted(types).map((t) => `events.${t}.count`),
    ...sorted(kinds).map((k) => `intervals.${k}.total_sec`),
    ...sorted(names).flatMap((n) => [`metrics.${n}.avg`, `metrics.${n}.max`]),
  ];
}
