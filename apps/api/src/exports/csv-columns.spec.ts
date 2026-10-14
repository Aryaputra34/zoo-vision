import { loadRegistry } from '@zoo-vision/contracts';
import { eventColumns, summaryColumns } from './csv-columns';

const registry = loadRegistry();
const BASE = [
  'time_local',
  'event_id',
  'camera_id',
  'camera_name',
  'use_case',
  'type',
  'severity',
  'config_version',
];

describe('eventColumns', () => {
  it('without a useCase or types filter: one JSON data column', () => {
    expect(eventColumns(registry)).toEqual([...BASE, 'data', 'snapshot_url']);
  });

  it('a useCase: one data.<field> column per property its event schemas declare, sorted', () => {
    expect(eventColumns(registry, 'horse_riding')).toEqual([
      ...BASE,
      'data.direction',
      'data.trackerId',
      'snapshot_url',
    ]);
    expect(eventColumns(registry, 'cashier_presence')).toEqual([
      ...BASE,
      'data.absentSec',
      'data.waitingSec',
      'snapshot_url',
    ]);
  });

  it('types: the fields of those types in any use case; with a useCase too, only its types', () => {
    expect(
      eventColumns(registry, undefined, ['customer_waiting', 'horse_crossing']),
    ).toEqual([
      ...BASE,
      'data.direction',
      'data.trackerId',
      'data.waitingSec',
      'snapshot_url',
    ]);
    expect(
      eventColumns(registry, 'cashier_presence', [
        'customer_waiting',
        'horse_crossing',
      ]),
    ).toEqual([...BASE, 'data.waitingSec', 'snapshot_url']);
  });

  it('a type no use case declares: no data columns at all', () => {
    expect(eventColumns(registry, undefined, ['no_such_type'])).toEqual([
      ...BASE,
      'snapshot_url',
    ]);
  });
});

describe('summaryColumns', () => {
  it('the four keys, then events, interval totals and metric avg/max of the use case, sorted', () => {
    expect(summaryColumns(registry, 'cashier_presence')).toEqual([
      'bucket_local',
      'camera_id',
      'camera_name',
      'use_case',
      'events.cashier_unattended.count',
      'events.customer_waiting.count',
      'intervals.desk_unattended.total_sec',
      'metrics.clerk_count.avg',
      'metrics.clerk_count.max',
      'metrics.queue_length.avg',
      'metrics.queue_length.max',
    ]);
  });

  it('without a useCase: every use case but system', () => {
    const columns = summaryColumns(registry);
    expect(columns).toContain('events.horse_crossing.count');
    expect(columns).toContain('intervals.table_session.total_sec');
    expect(columns).toContain('metrics.occupancy.max');
    expect(columns.some((c) => c.includes('engine_started'))).toBe(false);
    expect(columns.some((c) => c.includes('camera_offline'))).toBe(false);
    // a kind or name two use cases share appears once
    expect(
      columns.filter((c) => c === 'intervals.table_session.total_sec'),
    ).toHaveLength(1);
    expect(
      columns.filter((c) => c === 'metrics.occupied_tables.avg'),
    ).toHaveLength(1);
  });
});
