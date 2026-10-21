import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { addCamera, addEvent } from './helpers/analytics';
import { flushRedis, resetDb } from './setup/db';

type Row = {
  bucketStart: string;
  group: Record<string, string | null>;
  count: number;
  max?: number | null;
};
type Stats = { bucket: string; rows: Row[] };

// 2026-10-14 in Asia/Jakarta (UTC+7) is 2026-10-13T17:00Z .. 2026-10-14T17:00Z
const DAY = {
  from: '2026-10-14T00:00:00+07:00',
  to: '2026-10-15T00:00:00+07:00',
};

describe('GET /api/v1/reports/events/stats', () => {
  let app: INestApplication<App>;
  let cookie: string;
  let superadmin: string;

  const get = (
    query: Record<string, string>,
    session: string | null = cookie,
  ) => {
    const req = request(app.getHttpServer())
      .get('/api/v1/reports/events/stats')
      .query(query);
    return session ? req.set('Cookie', session) : req;
  };
  const stats = async (query: Record<string, string>): Promise<Stats> =>
    (await get(query).expect(200)).body as Stats;
  const crossing = (
    cameraId: string,
    time: string,
    data: Record<string, unknown>,
  ) =>
    addEvent({
      time,
      cameraId,
      useCase: 'horse_riding',
      type: 'horse_crossing',
      data,
    });

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    cookie = (await asRole(app, 'USER')).cookie;
    superadmin = (await asRole(app, 'SUPERADMIN')).cookie;

    for (const id of [
      'pony_hour',
      'pony_day',
      'pony_5m',
      'pony_null',
      'pony_sep',
    ]) {
      await addCamera(id, { useCase: 'horse_riding' });
    }
    for (const id of ['gate1', 'gate2']) {
      await addCamera(id, { useCase: 'vehicle_gate' });
    }
    for (const id of ['desk1', 'sev1', 'tz_cam']) await addCamera(id);

    // per hour and direction; the first event sits on `from`, the last on `to` (half-open range)
    await crossing('pony_hour', '2026-10-13T17:00:00Z', {
      direction: 'DEPARTURE',
      trackerId: 9,
    });
    await crossing('pony_hour', '2026-10-14T02:10:00Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await crossing('pony_hour', '2026-10-14T02:20:00Z', {
      direction: 'DEPARTURE',
      trackerId: 2,
    });
    await crossing('pony_hour', '2026-10-14T02:40:00Z', {
      direction: 'RETURN',
      trackerId: 1,
    });
    await crossing('pony_hour', '2026-10-14T03:05:00Z', {
      direction: 'DEPARTURE',
      trackerId: 3,
    });
    await crossing('pony_hour', '2026-10-14T17:00:00Z', {
      direction: 'RETURN',
      trackerId: 2,
    });

    // local day edges: 06:30, 23:59:59 and 00:00:30 the next day
    await crossing('pony_day', '2026-10-13T23:30:00Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await crossing('pony_day', '2026-10-14T16:59:59Z', {
      direction: 'RETURN',
      trackerId: 1,
    });
    await crossing('pony_day', '2026-10-14T17:00:30Z', {
      direction: 'DEPARTURE',
      trackerId: 2,
    });

    await crossing('pony_5m', '2026-10-14T02:07:30Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await crossing('pony_5m', '2026-10-14T02:09:59Z', {
      direction: 'DEPARTURE',
      trackerId: 2,
    });
    await crossing('pony_5m', '2026-10-14T02:12:10Z', {
      direction: 'RETURN',
      trackerId: 1,
    });

    // two with a direction, one without the key, one with a JSON null
    await crossing('pony_null', '2026-10-14T02:10:00Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await crossing('pony_null', '2026-10-14T02:11:00Z', {
      direction: 'DEPARTURE',
      trackerId: 2,
    });
    await crossing('pony_null', '2026-10-14T02:12:00Z', { trackerId: 3 });
    await crossing('pony_null', '2026-10-14T02:13:00Z', {
      direction: null,
      trackerId: 4,
    });

    const vehicle = (
      cameraId: string,
      vehicleType: string,
      direction: string,
      n: number,
    ) =>
      addEvent({
        time: '2026-10-14T01:15:00Z',
        cameraId,
        useCase: 'vehicle_gate',
        type: 'vehicle_crossing',
        data: { vehicleType, direction, trackerId: n },
      });
    await vehicle('gate1', 'car', 'ENTRY', 1);
    await vehicle('gate1', 'car', 'ENTRY', 2);
    await vehicle('gate1', 'bus', 'ENTRY', 3);
    await vehicle('gate1', 'car', 'EXIT', 4);
    await vehicle('gate2', 'car', 'ENTRY', 5);

    const waiting = (time: string, waitingSec: number) =>
      addEvent({
        time,
        cameraId: 'desk1',
        useCase: 'cashier_presence',
        type: 'customer_waiting',
        severity: 'warning',
        data: { waitingSec },
      });
    await waiting('2026-10-14T03:10:00Z', 30);
    await waiting('2026-10-14T03:50:00Z', 90);
    await waiting('2026-10-14T04:10:00Z', 20);

    // severity: 2 info, 3 warning, 1 critical
    await crossing('sev1', '2026-10-14T05:00:00Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await crossing('sev1', '2026-10-14T05:01:00Z', {
      direction: 'RETURN',
      trackerId: 1,
    });
    for (const minute of [10, 11, 12]) {
      await addEvent({
        time: `2026-10-14T05:${minute}:00Z`,
        cameraId: 'sev1',
        useCase: 'cashier_presence',
        type: 'customer_waiting',
        severity: 'warning',
        data: { waitingSec: 60 },
      });
    }
    await addEvent({
      time: '2026-10-14T05:20:00Z',
      cameraId: 'sev1',
      useCase: 'cashier_presence',
      type: 'cashier_unattended',
      severity: 'critical',
      data: { absentSec: 300 },
    });

    // a quiet day of its own: one crossing and one system event
    await crossing('pony_sep', '2026-09-01T03:00:00Z', {
      direction: 'DEPARTURE',
      trackerId: 1,
    });
    await addEvent({
      time: '2026-09-01T01:00:00Z',
      cameraId: null,
      useCase: 'system',
      type: 'engine_started',
      data: { bootId: 'a'.repeat(32), engineGroup: 'default' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('horse_crossing grouped by data.direction per hour: the seeded counts for each hour and direction', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'hour',
      types: 'horse_crossing',
      groupBy: 'data.direction',
      cameraIds: 'pony_hour',
    });
    expect(body.bucket).toBe('hour');
    expect(
      body.rows.map((r) => [r.bucketStart, r.group['data.direction'], r.count]),
    ).toEqual([
      ['2026-10-13T17:00:00.000Z', 'DEPARTURE', 1], // on `from`: included
      ['2026-10-14T02:00:00.000Z', 'DEPARTURE', 2],
      ['2026-10-14T02:00:00.000Z', 'RETURN', 1],
      ['2026-10-14T03:00:00.000Z', 'DEPARTURE', 1],
      // the RETURN on `to` is outside the half-open range
    ]);
  });

  it('a crossing at 2026-10-13T23:30:00Z falls in the day bucket 2026-10-13T17:00:00.000Z (Asia/Jakarta)', async () => {
    const body = await stats({
      from: '2026-10-14T00:00:00+07:00',
      to: '2026-10-16T00:00:00+07:00',
      bucket: 'day',
      cameraIds: 'pony_day',
    });
    expect(body.rows).toEqual([
      { bucketStart: '2026-10-13T17:00:00.000Z', group: {}, count: 2 },
      { bucketStart: '2026-10-14T17:00:00.000Z', group: {}, count: 1 },
    ]);
  });

  it('5m buckets start on local 5-minute boundaries', async () => {
    const five = await stats({ ...DAY, bucket: '5m', cameraIds: 'pony_5m' });
    expect(five.rows.map((r) => [r.bucketStart, r.count])).toEqual([
      ['2026-10-14T02:05:00.000Z', 2],
      ['2026-10-14T02:10:00.000Z', 1],
    ]);
    const fifteen = await stats({
      ...DAY,
      bucket: '15m',
      cameraIds: 'pony_5m',
    });
    expect(fifteen.rows.map((r) => [r.bucketStart, r.count])).toEqual([
      ['2026-10-14T02:00:00.000Z', 3],
    ]);
  });

  it('groupBy=camera,data.vehicleType,data.direction gives one row per camera, bucket, type and direction, keys in group', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'hour',
      types: 'vehicle_crossing',
      groupBy: 'camera,data.vehicleType,data.direction',
      cameraIds: 'gate1,gate2',
    });
    expect(Object.keys(body.rows[0].group)).toEqual([
      'camera',
      'data.vehicleType',
      'data.direction',
    ]);
    expect(
      body.rows.map((r) => [
        r.bucketStart,
        r.group.camera,
        r.group['data.vehicleType'],
        r.group['data.direction'],
        r.count,
      ]),
    ).toEqual([
      ['2026-10-14T01:00:00.000Z', 'gate1', 'bus', 'ENTRY', 1],
      ['2026-10-14T01:00:00.000Z', 'gate1', 'car', 'ENTRY', 2],
      ['2026-10-14T01:00:00.000Z', 'gate1', 'car', 'EXIT', 1],
      ['2026-10-14T01:00:00.000Z', 'gate2', 'car', 'ENTRY', 1],
    ]);
  });

  it('groupBy=type puts the event type in group; types and cameraIds filter', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'day',
      groupBy: 'type',
      cameraIds: 'sev1,desk1',
      types: 'customer_waiting,cashier_unattended',
    });
    expect(body.rows.map((r) => [r.group.type, r.count])).toEqual([
      ['cashier_unattended', 1],
      ['customer_waiting', 6],
    ]);
  });

  it('groupBy=severity counts info, warning and critical events separately', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'day',
      groupBy: 'severity',
      cameraIds: 'sev1',
    });
    expect(body.rows.map((r) => [r.group.severity, r.count])).toEqual([
      ['critical', 1],
      ['info', 2],
      ['warning', 3],
    ]);
  });

  it('max=waitingSec on customer_waiting returns the largest waitingSec per bucket', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'hour',
      types: 'customer_waiting',
      max: 'waitingSec',
      cameraIds: 'desk1',
    });
    expect(body.rows).toEqual([
      { bucketStart: '2026-10-14T03:00:00.000Z', group: {}, count: 2, max: 90 },
      { bucketStart: '2026-10-14T04:00:00.000Z', group: {}, count: 1, max: 20 },
    ]);
  });

  it('rows without the grouped field come back with group["data.<field>"] null', async () => {
    const body = await stats({
      ...DAY,
      bucket: 'hour',
      types: 'horse_crossing',
      groupBy: 'data.direction',
      cameraIds: 'pony_null',
    });
    expect(body.rows.map((r) => [r.group['data.direction'], r.count])).toEqual([
      ['DEPARTURE', 2],
      [null, 2],
    ]);
  });

  it('groupBy=data.snapshot, data.nope, three data fields, or data.direction without types → 400 FIELD_NOT_ALLOWED', async () => {
    const bad: Record<string, string>[] = [
      { types: 'horse_crossing', groupBy: 'data.snapshot' },
      { types: 'horse_crossing', groupBy: 'data.nope' },
      { types: 'horse_crossing', groupBy: 'data.trackerId' }, // an integer, not a string or enum
      { types: 'horse_crossing', groupBy: 'camera,time' },
      {
        types: 'horse_crossing',
        groupBy: `data.direction';DROP TABLE "Event";--`,
      },
      {
        types: 'vehicle_crossing',
        groupBy: 'data.direction,data.vehicleType,data.plate',
      },
      { groupBy: 'data.direction' },
      { types: 'horse_crossing', max: 'direction' }, // an enum, not a number
      { max: 'waitingSec' },
      { types: 'horse_crossing', max: 'nope' },
    ];
    for (const query of bad) {
      const res = await get({ ...DAY, bucket: 'hour', ...query }).expect(400);
      expect([query, (res.body as { code: string }).code]).toEqual([
        query,
        'FIELD_NOT_ALLOWED',
      ]);
    }
  });

  it('hour buckets over 32 days → 400 RANGE_TOO_LONG; from ≥ to → 400 VALIDATION_FAILED', async () => {
    const long = await get({
      from: '2026-09-01T00:00:00+07:00',
      to: '2026-10-03T00:00:00+07:00',
      bucket: 'hour',
    }).expect(400);
    expect(long.body).toMatchObject({
      statusCode: 400,
      code: 'RANGE_TOO_LONG',
    });

    const invalid: Record<string, string>[] = [
      { from: DAY.to, to: DAY.from, bucket: 'hour' },
      { from: DAY.from, to: DAY.from, bucket: 'hour' },
      { from: '2026-10-14T00:00:00', to: DAY.to, bucket: 'hour' }, // no offset
      { ...DAY, bucket: 'week' },
      { ...DAY },
      { from: DAY.from, bucket: 'hour' },
    ];
    for (const query of invalid) {
      const res = await get(query).expect(400);
      expect([query, (res.body as { code: string }).code]).toEqual([
        query,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('system events are absent unless asked for', async () => {
    const day = {
      from: '2026-09-01T00:00:00+07:00',
      to: '2026-09-02T00:00:00+07:00',
      bucket: 'day',
    };
    const plain = await stats({ ...day, groupBy: 'type' });
    expect(plain.rows.map((r) => [r.group.type, r.count])).toEqual([
      ['horse_crossing', 1],
    ]);
    const byUseCase = await stats({
      ...day,
      groupBy: 'type',
      useCase: 'system',
    });
    expect(byUseCase.rows.map((r) => [r.group.type, r.count])).toEqual([
      ['engine_started', 1],
    ]);
    const byType = await stats({
      ...day,
      groupBy: 'type',
      types: 'engine_started,horse_crossing',
    });
    expect(byType.rows.map((r) => [r.group.type, r.count])).toEqual([
      ['engine_started', 1],
      ['horse_crossing', 1],
    ]);
    // a system event has no camera: its camera group is null
    const withCamera = await stats({
      ...day,
      groupBy: 'camera',
      useCase: 'system',
    });
    expect(withCamera.rows[0].group).toEqual({ camera: null });
  });

  it('as USER → 200; without a session → 401', async () => {
    await get({ ...DAY, bucket: 'day' }).expect(200);
    const res = await get({ ...DAY, bucket: 'day' }, null).expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  describe('with another site time zone (PATCH /site-settings)', () => {
    const setZone = (timeZone: string) =>
      request(app.getHttpServer())
        .patch('/api/v1/site-settings')
        .set('Cookie', superadmin)
        .send({ timeZone })
        .expect(200);
    // the zone is shared by every suite through the database: always put it back
    afterAll(() => setZone('Asia/Jakarta'));
    const inZone = async (
      zone: string,
      query: Record<string, string>,
    ): Promise<Row[]> => {
      await setZone(zone);
      const res = await get({ cameraIds: 'tz_cam', ...query }).expect(200);
      return (res.body as Stats).rows;
    };
    const at = (time: string) =>
      addEvent({
        time,
        cameraId: 'tz_cam',
        useCase: 'cashier_presence',
        type: 'customer_waiting',
        data: { waitingSec: 1 },
      });

    it('Asia/Kolkata (+05:30): an hour bucket starts at local :00, half an hour off UTC', async () => {
      await at('2026-10-20T02:10:00Z'); // 07:40 local
      const rows = await inZone('Asia/Kolkata', {
        from: '2026-10-20T00:00:00Z',
        to: '2026-10-21T00:00:00Z',
        bucket: 'hour',
      });
      expect(rows.map((r) => [r.bucketStart, r.count])).toEqual([
        ['2026-10-20T01:30:00.000Z', 1],
      ]);
    });

    it('America/New_York: day buckets are 25 hours across the fall-back and each hour of the repeated hour is its own bucket', async () => {
      await at('2026-11-01T05:30:00Z'); // 01:30 EDT, Nov 1
      await at('2026-11-01T06:30:00Z'); // 01:30 EST, the repeated hour
      await at('2026-11-02T04:30:00Z'); // 23:30 EST, Nov 1
      await at('2026-11-02T05:30:00Z'); // 00:30 EST, Nov 2
      const days = await inZone('America/New_York', {
        from: '2026-11-01T00:00:00-04:00',
        to: '2026-11-03T00:00:00-05:00',
        bucket: 'day',
      });
      expect(days.map((r) => [r.bucketStart, r.count])).toEqual([
        ['2026-11-01T04:00:00.000Z', 3],
        ['2026-11-02T05:00:00.000Z', 1],
      ]);
      const hours = await inZone('America/New_York', {
        from: '2026-11-01T04:00:00Z',
        to: '2026-11-01T08:00:00Z',
        bucket: 'hour',
      });
      expect(hours.map((r) => [r.bucketStart, r.count])).toEqual([
        ['2026-11-01T05:00:00.000Z', 1],
        ['2026-11-01T06:00:00.000Z', 1],
      ]);
    });
  });
});
