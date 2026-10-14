import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { addCamera, addInterval, addMetric } from './helpers/analytics';
import { flushRedis, resetDb } from './setup/db';

type IntervalRow = {
  bucketStart: string;
  cameraId?: string;
  subjectId?: string | null;
  count: number;
  totalSec: number;
  avgSec: number | null;
  maxSec: number | null;
};
type MetricRow = { bucketStart: string; cameraId: string; value: number };

// 2026-10-14 in Asia/Jakarta (UTC+7) is 2026-10-13T17:00Z .. 2026-10-14T17:00Z
const DAY = {
  from: '2026-10-14T00:00:00+07:00',
  to: '2026-10-15T00:00:00+07:00',
};
const MIN = 60_000;

describe('GET /api/v1/reports/intervals/stats and /metrics/series', () => {
  let app: INestApplication<App>;
  let cookie: string;

  const getIntervals = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/reports/intervals/stats')
      .set('Cookie', cookie)
      .query(query);
  const intervals = async (
    query: Record<string, string>,
  ): Promise<IntervalRow[]> =>
    ((await getIntervals(query).expect(200)).body as { rows: IntervalRow[] })
      .rows;
  const getMetrics = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/reports/metrics/series')
      .set('Cookie', cookie)
      .query(query);
  const metrics = async (query: Record<string, string>): Promise<MetricRow[]> =>
    ((await getMetrics(query).expect(200)).body as { rows: MetricRow[] }).rows;
  const tuples = (rows: IntervalRow[]) =>
    rows.map((r) => [r.bucketStart, r.count, r.totalSec, r.avgSec, r.maxSec]);
  const desk = (cameraId: string, start: string, end: string | null) =>
    addInterval({
      cameraId,
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start,
      end,
    });

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    cookie = (await asRole(app, 'USER')).cookie;

    for (const id of [
      'iv1',
      'iv_open',
      'iv_open_past',
      'iv_avg',
      'edge',
      'split',
      'before',
      'unaligned',
      'desk_a',
    ]) {
      await addCamera(id);
    }
    for (const id of ['rest_a', 'rest_b', 'm_rest']) {
      await addCamera(id, { useCase: 'restaurant_counter' });
    }

    // 10:50-11:20 local
    await desk('iv1', '2026-10-14T03:50:00Z', '2026-10-14T04:20:00Z');

    // open since 90 minutes ago, and one that opened long ago in the past
    await desk('iv_open', new Date(Date.now() - 90 * MIN).toISOString(), null);
    await desk('iv_open_past', '2026-10-01T03:00:00Z', null);

    // start 12:00, 12:10, 12:20 local; last 10, 20 and 90 minutes
    await desk('iv_avg', '2026-10-14T05:00:00Z', '2026-10-14T05:10:00Z');
    await desk('iv_avg', '2026-10-14T05:10:00Z', '2026-10-14T05:30:00Z');
    await desk('iv_avg', '2026-10-14T05:20:00Z', '2026-10-14T06:50:00Z');

    // exactly one local hour, on the edges
    await desk('edge', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z');
    // 22:00 to 02:00 local over midnight, and one still open at to
    await desk('split', '2026-10-14T15:00:00Z', '2026-10-14T19:00:00Z');
    // started at 23:30 local the day before, ended 00:40 local
    await desk('before', '2026-10-13T16:30:00Z', '2026-10-13T17:40:00Z');

    // 11:05-11:20 local, for a range that starts at 11:10 inside its bucket
    await desk('unaligned', '2026-10-14T04:05:00Z', '2026-10-14T04:20:00Z');

    // tables: T1 and T2 on rest_a, T1 again on rest_b
    const table = (cameraId: string, subjectId: string, end: string) =>
      addInterval({
        cameraId,
        useCase: 'restaurant_counter',
        kind: 'table_session',
        subjectId,
        start: '2026-10-14T05:00:00Z',
        end,
      });
    await table('rest_a', 'T1', '2026-10-14T05:30:00Z');
    await table('rest_a', 'T2', '2026-10-14T05:10:00Z');
    await table('rest_b', 'T1', '2026-10-14T05:20:00Z');

    // the same camera was offline too; it must not show up as a desk interval
    await addInterval({
      cameraId: 'desk_a',
      useCase: 'system',
      kind: 'camera_offline',
      start: '2026-10-14T01:00:00Z',
      end: '2026-10-14T01:30:00Z',
      endReason: 'online',
    });
    await desk('desk_a', '2026-10-14T02:00:00Z', '2026-10-14T02:10:00Z');
    await desk('desk_a', '2026-10-14T02:30:00Z', '2026-10-14T02:35:00Z');

    // occupancy at 12:00..12:09 local on m_rest; one minute exactly at `to` of the query
    const values = [40, 42, 45, 50, 44, 46, 30, 45, 10, 47];
    for (const [i, value] of values.entries()) {
      await addMetric({
        cameraId: 'm_rest',
        useCase: 'restaurant_counter',
        name: 'occupancy',
        minute: new Date(Date.UTC(2026, 9, 14, 5, i)).toISOString(),
        value,
      });
    }
    await addMetric({
      cameraId: 'm_rest',
      useCase: 'restaurant_counter',
      name: 'occupancy',
      minute: '2026-10-14T05:10:00Z',
      value: 99,
    });
    await addMetric({
      cameraId: 'm_rest',
      useCase: 'restaurant_counter',
      name: 'occupied_tables',
      minute: '2026-10-14T05:00:00Z',
      value: 7,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('an interval 10:50–11:20 local adds 600 s to the 10:00 bucket and 1200 s to the 11:00 bucket; count 1 only at 10:00', async () => {
    const rows = await intervals({
      ...DAY,
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'iv1',
    });
    expect(tuples(rows)).toEqual([
      ['2026-10-14T03:00:00.000Z', 1, 600, 1800, 1800],
      ['2026-10-14T04:00:00.000Z', 0, 1200, null, null],
    ]);
  });

  it('an open interval counts up to now; with to in the past, up to to', async () => {
    const live = await intervals({
      from: new Date(Date.now() - 3 * 3600_000).toISOString(),
      to: new Date(Date.now() + 3 * 3600_000).toISOString(),
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'iv_open',
    });
    const total = live.reduce((sum, r) => sum + r.totalSec, 0);
    expect(total).toBeGreaterThanOrEqual(90 * 60);
    expect(total).toBeLessThan(90 * 60 + 120);
    expect(live.reduce((sum, r) => sum + r.count, 0)).toBe(1);

    const past = await intervals({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-01T04:30:00Z',
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'iv_open_past',
    });
    expect(tuples(past)).toEqual([
      ['2026-10-01T03:00:00.000Z', 1, 3600, 5400, 5400],
      ['2026-10-01T04:00:00.000Z', 0, 1800, null, null],
    ]);
  });

  it('avgSec and maxSec use whole durations of the intervals that start in the bucket', async () => {
    const rows = await intervals({
      ...DAY,
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'iv_avg',
    });
    expect(tuples(rows)).toEqual([
      // 600 + 1200 + 40 minutes of the 90-minute one
      ['2026-10-14T05:00:00.000Z', 3, 4200, 2400, 5400],
      // its last 50 minutes
      ['2026-10-14T06:00:00.000Z', 0, 3000, null, null],
    ]);
  });

  it('an interval that ends on a bucket edge makes no extra bucket; one that crosses midnight is split between the day buckets', async () => {
    const edge = await intervals({
      ...DAY,
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'edge',
    });
    expect(tuples(edge)).toEqual([
      ['2026-10-14T08:00:00.000Z', 1, 3600, 3600, 3600],
    ]);

    const split = await intervals({
      from: '2026-10-14T00:00:00+07:00',
      to: '2026-10-16T00:00:00+07:00',
      bucket: 'day',
      kind: 'desk_unattended',
      cameraIds: 'split',
    });
    expect(tuples(split)).toEqual([
      ['2026-10-13T17:00:00.000Z', 1, 7200, 14400, 14400],
      ['2026-10-14T17:00:00.000Z', 0, 7200, null, null],
    ]);
  });

  it('an interval that started before from adds only the part inside the range and is not counted', async () => {
    const rows = await intervals({
      ...DAY,
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'before',
    });
    // 00:00-00:40 local of the 70-minute interval, in the 00:00 bucket
    expect(tuples(rows)).toEqual([
      ['2026-10-13T17:00:00.000Z', 0, 2400, null, null],
    ]);
  });

  it('an interval that started before a from inside its first bucket is not counted either', async () => {
    const rows = await intervals({
      from: '2026-10-14T11:10:00+07:00',
      to: '2026-10-14T12:00:00+07:00',
      bucket: 'hour',
      kind: 'desk_unattended',
      cameraIds: 'unaligned',
    });
    // 11:10-11:20 is inside the range; it started at 11:05, before from
    expect(tuples(rows)).toEqual([
      ['2026-10-14T04:00:00.000Z', 0, 600, null, null],
    ]);
  });

  it('groupBy=subject separates table ids (and cameras: an id is only unique within its camera)', async () => {
    const rows = await intervals({
      ...DAY,
      bucket: 'day',
      kind: 'table_session',
      groupBy: 'subject',
      cameraIds: 'rest_a,rest_b',
    });
    expect(
      rows.map((r) => [r.cameraId, r.subjectId, r.count, r.totalSec]),
    ).toEqual([
      ['rest_a', 'T1', 1, 1800],
      ['rest_a', 'T2', 1, 600],
      ['rest_b', 'T1', 1, 1200],
    ]);

    const byCamera = await intervals({
      ...DAY,
      bucket: 'day',
      kind: 'table_session',
      groupBy: 'camera',
      cameraIds: 'rest_a,rest_b',
    });
    expect(
      byCamera.map((r) => [r.cameraId, r.subjectId, r.count, r.totalSec]),
    ).toEqual([
      ['rest_a', undefined, 2, 2400],
      ['rest_b', undefined, 1, 1200],
    ]);

    const all = await intervals({
      ...DAY,
      bucket: 'day',
      kind: 'table_session',
      cameraIds: 'rest_a,rest_b',
    });
    expect(all).toEqual([
      {
        bucketStart: '2026-10-13T17:00:00.000Z',
        count: 3,
        totalSec: 3600,
        avgSec: 1200,
        maxSec: 1800,
      },
    ]);
  });

  it('camera_offline intervals do not appear in desk_unattended stats', async () => {
    const desks = await intervals({
      ...DAY,
      bucket: 'day',
      kind: 'desk_unattended',
      cameraIds: 'desk_a',
    });
    expect(desks).toEqual([
      {
        bucketStart: '2026-10-13T17:00:00.000Z',
        count: 2,
        totalSec: 900,
        avgSec: 450,
        maxSec: 600,
      },
    ]);
    const offline = await intervals({
      ...DAY,
      bucket: 'day',
      kind: 'camera_offline',
      cameraIds: 'desk_a',
    });
    expect(offline[0]).toMatchObject({ count: 1, totalSec: 1800 });
  });

  it('occupancy agg=max per 5m bucket; above=45 counts the minutes at or above 45', async () => {
    const base = {
      ...DAY,
      bucket: '5m',
      name: 'occupancy',
      cameraIds: 'm_rest',
    };
    expect(await metrics({ ...base, agg: 'max' })).toEqual([
      {
        bucketStart: '2026-10-14T05:00:00.000Z',
        cameraId: 'm_rest',
        value: 50,
      },
      {
        bucketStart: '2026-10-14T05:05:00.000Z',
        cameraId: 'm_rest',
        value: 47,
      },
      // the 99 at 05:10 is a minute of the next bucket
      {
        bucketStart: '2026-10-14T05:10:00.000Z',
        cameraId: 'm_rest',
        value: 99,
      },
    ]);
    expect(
      (await metrics({ ...base, agg: 'min' })).map((r) => r.value),
    ).toEqual([40, 10, 99]);
    expect(
      (await metrics({ ...base, agg: 'avg' })).map((r) => r.value),
    ).toEqual([44.2, 35.6, 99]);
    expect(
      (await metrics({ ...base, above: '45' })).map((r) => r.value),
    ).toEqual([2, 3, 1]);
  });

  it('a metric minute on `to` is outside the range; other metric names stay out', async () => {
    const rows = await metrics({
      from: '2026-10-14T12:00:00+07:00',
      to: '2026-10-14T12:10:00+07:00',
      bucket: 'hour',
      name: 'occupancy',
      agg: 'max',
    });
    expect(rows).toEqual([
      {
        bucketStart: '2026-10-14T05:00:00.000Z',
        cameraId: 'm_rest',
        value: 50,
      },
    ]);
  });

  it('agg and above together, or neither → 400 VALIDATION_FAILED', async () => {
    const base = { ...DAY, bucket: 'hour', name: 'occupancy' };
    for (const query of [
      { ...base, agg: 'max', above: '45' },
      { ...base },
      { ...base, agg: 'sum' },
      { ...base, above: 'many' },
      { ...DAY, bucket: 'hour', agg: 'max' }, // no name
    ]) {
      const res = await getMetrics(query).expect(400);
      expect([query, (res.body as { code: string }).code]).toEqual([
        query,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('a missing kind, a bad groupBy, a too long range → 400', async () => {
    const base = { ...DAY, bucket: 'hour', kind: 'desk_unattended' };
    const noKind = await getIntervals({ ...DAY, bucket: 'hour' }).expect(400);
    expect(noKind.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const badGroup = await getIntervals({ ...base, groupBy: 'zone' }).expect(
      400,
    );
    expect(badGroup.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const long = await getIntervals({
      ...base,
      to: '2026-12-31T00:00:00+07:00',
    }).expect(400);
    expect(long.body).toMatchObject({ code: 'RANGE_TOO_LONG' });
    const longMetric = await getMetrics({
      ...DAY,
      to: '2026-12-31T00:00:00+07:00',
      bucket: '5m',
      name: 'occupancy',
      agg: 'max',
    }).expect(400);
    expect(longMetric.body).toMatchObject({ code: 'RANGE_TOO_LONG' });
  });

  it('as USER → 200; without a session → 401', async () => {
    await getIntervals({ ...DAY, bucket: 'day', kind: 'x' }).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/reports/intervals/stats')
      .query({ ...DAY, bucket: 'day', kind: 'x' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/reports/metrics/series')
      .query({ ...DAY, bucket: 'day', name: 'x', agg: 'max' })
      .expect(401);
  });
});
