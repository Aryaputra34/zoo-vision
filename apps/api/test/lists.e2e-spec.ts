import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { addCamera, addEvent, addInterval } from './helpers/analytics';
import { flushRedis, resetDb } from './setup/db';

type EventRow = {
  id: string;
  time: string;
  cameraId: string | null;
  cameraName: string | null;
  useCase: string;
  type: string;
  severity: string;
  configVersion: number | null;
  data: Record<string, unknown>;
  snapshotUrl: string | null;
  clipUrl: string | null;
};
type IntervalRow = {
  id: string;
  cameraId: string;
  cameraName: string;
  useCase: string;
  kind: string;
  subjectId: string | null;
  start: string;
  end: string | null;
  endReason: string | null;
  durationSec: number | null;
  data: Record<string, unknown>;
};
type Page<T> = { rows: T[]; nextCursor: string | null };

const DAY = {
  from: '2026-10-14T00:00:00Z',
  to: '2026-10-15T00:00:00Z',
};

describe('GET /api/v1/events and /api/v1/intervals', () => {
  let app: INestApplication<App>;
  let cookie: string;

  const getEvents = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/events')
      .set('Cookie', cookie)
      .query({ ...DAY, ...query });
  const events = async (query: Record<string, string>) =>
    (await getEvents(query).expect(200)).body as Page<EventRow>;
  const getIntervals = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/intervals')
      .set('Cookie', cookie)
      .query({ ...DAY, ...query });
  const intervals = async (query: Record<string, string>) =>
    (await getIntervals(query).expect(200)).body as Page<IntervalRow>;
  const ids = (page: Page<{ id: string }>) => page.rows.map((r) => r.id);

  const horse = (id: string, cameraId: string, time: string) =>
    addEvent({
      id,
      time,
      cameraId,
      useCase: 'horse_riding',
      type: 'horse_crossing',
      data: { direction: 'DEPARTURE', trackerId: 1 },
    });
  const crossing = (
    cameraId: string,
    vehicleType: string,
    direction: string,
    time: string,
  ) =>
    addEvent({
      time,
      cameraId,
      useCase: 'vehicle_gate',
      type: 'vehicle_crossing',
      data: { vehicleType, direction, trackerId: 1 },
    });

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    cookie = (await asRole(app, 'USER')).cookie;

    await addCamera('pg', { useCase: 'horse_riding' });
    await addCamera('sev');
    await addCamera('gates', { useCase: 'vehicle_gate' });
    await addCamera('rec', {
      name: 'Gate with recording',
      useCase: 'horse_riding',
      recordingPath: 'rec',
      recordingEnabled: true,
    });
    await addCamera('rec_off', {
      useCase: 'horse_riding',
      recordingPath: 'rec_off',
      recordingEnabled: false,
    });
    await addCamera('rec_none', { useCase: 'horse_riding' });
    await addCamera('ivs');

    // five minutes of events, two of them at the same instant
    await horse('evt_pg_1', 'pg', '2026-10-14T10:00:00Z');
    await horse('evt_pg_2', 'pg', '2026-10-14T10:01:00Z');
    await horse('evt_pg_3a', 'pg', '2026-10-14T10:02:00Z');
    await horse('evt_pg_3b', 'pg', '2026-10-14T10:02:00Z');
    await horse('evt_pg_4', 'pg', '2026-10-14T10:03:00Z');
    await horse('evt_pg_5', 'pg', '2026-10-14T10:04:00Z');

    await addEvent({
      id: 'evt_sev_info',
      time: '2026-10-14T11:00:00Z',
      cameraId: 'sev',
      useCase: 'horse_riding',
      type: 'horse_crossing',
      severity: 'info',
      data: { direction: 'RETURN', trackerId: 1 },
    });
    await addEvent({
      id: 'evt_sev_warn',
      time: '2026-10-14T11:01:00Z',
      cameraId: 'sev',
      useCase: 'cashier_presence',
      type: 'customer_waiting',
      severity: 'warning',
      data: { waitingSec: 70 },
    });
    await addEvent({
      id: 'evt_sev_crit',
      time: '2026-10-14T11:02:00Z',
      cameraId: 'sev',
      useCase: 'cashier_presence',
      type: 'cashier_unattended',
      severity: 'critical',
      data: { absentSec: 300 },
    });

    await crossing('gates', 'car', 'ENTRY', '2026-10-14T12:00:00Z');
    await crossing('gates', 'bus', 'ENTRY', '2026-10-14T12:01:00Z');
    await crossing('gates', 'bus', 'EXIT', '2026-10-14T12:02:00Z');
    await crossing('gates', 'bus', 'ENTRY', '2026-10-14T12:03:00Z');

    await addEvent({
      id: 'evt_snap_odd',
      time: '2026-10-14T13:00:00Z',
      cameraId: 'rec',
      useCase: 'horse_riding',
      type: 'horse_crossing',
      data: { direction: 'DEPARTURE', trackerId: 2 },
      snapshotPath: 'cam 1/2026-10-14/évt#1?.jpg',
    });
    await addEvent({
      id: 'evt_snap_plain',
      time: '2026-10-14T13:01:00Z',
      cameraId: 'rec',
      useCase: 'horse_riding',
      type: 'horse_crossing',
      data: { direction: 'DEPARTURE', trackerId: 3 },
      snapshotPath: 'rec/2026-10-14/evt_snap_plain.jpg',
    });
    await horse('evt_clip_off', 'rec_off', '2026-10-14T13:02:00Z');
    await horse('evt_clip_none', 'rec_none', '2026-10-14T13:03:00Z');

    await addEvent({
      id: 'evt_system',
      time: '2026-10-14T14:00:00Z',
      cameraId: null,
      useCase: 'system',
      type: 'engine_started',
      data: { bootId: 'b'.repeat(32), engineGroup: 'default' },
    });

    await addInterval({
      id: 'ses_open',
      cameraId: 'ivs',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T15:00:00Z',
    });
    await addInterval({
      id: 'ses_closed',
      cameraId: 'ivs',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-14T15:10:00Z',
      end: '2026-10-14T15:20:00Z',
      endReason: 'returned',
    });
    await addInterval({
      id: 'ses_table',
      cameraId: 'ivs',
      useCase: 'restaurant_table',
      kind: 'table_session',
      subjectId: 'T1',
      start: '2026-10-14T15:05:00Z',
      end: '2026-10-14T15:25:00Z',
      data: { tableName: 'Table 1' },
    });
    // started the day before, still overlapping the range: listed by `start`, so not here
    await addInterval({
      id: 'ses_before',
      cameraId: 'ivs',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      start: '2026-10-13T23:50:00Z',
      end: '2026-10-14T00:10:00Z',
    });
    await addInterval({
      id: 'ses_offline',
      cameraId: 'ivs',
      useCase: 'system',
      kind: 'camera_offline',
      start: '2026-10-14T16:00:00Z',
      end: '2026-10-14T16:05:00Z',
      endReason: 'online',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('newest first; limit 2 then nextCursor gives the next 2, with no overlap and no gap even when newer rows arrive in between', async () => {
    const first = await events({ cameraIds: 'pg', limit: '2' });
    expect(ids(first)).toEqual(['evt_pg_5', 'evt_pg_4']);
    expect(first.nextCursor).toEqual(expect.any(String));

    // newer rows land after page 1 was served
    await horse('evt_pg_6', 'pg', '2026-10-14T10:05:00Z');
    await horse('evt_pg_4b', 'pg', '2026-10-14T10:03:30Z');

    const second = await events({
      cameraIds: 'pg',
      limit: '2',
      cursor: first.nextCursor as string,
    });
    // the two events with the same time are told apart by id
    expect(ids(second)).toEqual(['evt_pg_3b', 'evt_pg_3a']);
    const third = await events({
      cameraIds: 'pg',
      limit: '2',
      cursor: second.nextCursor as string,
    });
    expect(ids(third)).toEqual(['evt_pg_2', 'evt_pg_1']);
    expect(third.nextCursor).toBeNull();

    // the rows of one request: 3 events at 10:05, 10:04, 10:03:30 ... all before the cursor
    const all = await events({ cameraIds: 'pg' });
    expect(ids(all)).toEqual([
      'evt_pg_6',
      'evt_pg_5',
      'evt_pg_4b',
      'evt_pg_4',
      'evt_pg_3b',
      'evt_pg_3a',
      'evt_pg_2',
      'evt_pg_1',
    ]);
    expect(all.nextCursor).toBeNull();
  });

  it('rows carry the camera name, the config version and the data', async () => {
    const page = await events({ cameraIds: 'rec', types: 'horse_crossing' });
    expect(page.rows[0]).toMatchObject({
      id: 'evt_snap_plain',
      time: '2026-10-14T13:01:00.000Z',
      cameraId: 'rec',
      cameraName: 'Gate with recording',
      useCase: 'horse_riding',
      type: 'horse_crossing',
      severity: 'info',
      configVersion: null,
      data: { direction: 'DEPARTURE', trackerId: 3 },
    });
  });

  it('severity=warning,critical filters; types filters; an unknown severity is a 400', async () => {
    const serious = await events({
      cameraIds: 'sev',
      severity: 'warning,critical',
    });
    expect(ids(serious)).toEqual(['evt_sev_crit', 'evt_sev_warn']);
    const typed = await events({ cameraIds: 'sev', types: 'horse_crossing' });
    expect(ids(typed)).toEqual(['evt_sev_info']);
    const res = await getEvents({ severity: 'fatal' }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('where=data.direction:ENTRY,data.vehicleType:bus returns only those crossings; where on an undeclared field or without types → 400 FIELD_NOT_ALLOWED', async () => {
    const page = await events({
      cameraIds: 'gates',
      types: 'vehicle_crossing',
      where: 'data.direction:ENTRY,data.vehicleType:bus',
    });
    expect(page.rows.map((r) => r.time)).toEqual([
      '2026-10-14T12:03:00.000Z',
      '2026-10-14T12:01:00.000Z',
    ]);

    const none = await events({
      cameraIds: 'gates',
      types: 'vehicle_crossing',
      where: `data.vehicleType:bus' OR '1'='1`,
    });
    expect(none.rows).toEqual([]); // a value is a bound parameter, not SQL

    const types = { types: 'vehicle_crossing' };
    for (const query of [
      { ...types, where: 'data.nope:1' },
      { ...types, where: 'data.trackerId:1' }, // an integer, not a string or enum
      { where: 'data.direction:ENTRY' }, // no types
      {
        ...types,
        where: 'data.direction:ENTRY,data.vehicleType:bus,data.plate:B1234XY',
      },
    ]) {
      const res = await getEvents(query).expect(400);
      expect([query, (res.body as { code: string }).code]).toEqual([
        query,
        'FIELD_NOT_ALLOWED',
      ]);
    }
    for (const where of [
      'direction:ENTRY',
      'data.direction',
      'data.direction:',
    ]) {
      const res = await getEvents({ ...types, where }).expect(400);
      expect([where, (res.body as { code: string }).code]).toEqual([
        where,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('snapshotUrl encodes every path segment; null without a snapshotPath', async () => {
    const page = await events({ cameraIds: 'rec' });
    const byId = Object.fromEntries(page.rows.map((r) => [r.id, r]));
    expect(byId.evt_snap_odd.snapshotUrl).toBe(
      '/media/snapshots/cam%201/2026-10-14/%C3%A9vt%231%3F.jpg',
    );
    expect(byId.evt_snap_plain.snapshotUrl).toBe(
      '/media/snapshots/rec/2026-10-14/evt_snap_plain.jpg',
    );
    const none = await events({ cameraIds: 'sev' });
    expect(none.rows.every((r) => r.snapshotUrl === null)).toBe(true);
  });

  it('clipUrl only for cameras with a recordingPath and recording on', async () => {
    const page = await events({ cameraIds: 'rec,rec_off,rec_none' });
    const clip = Object.fromEntries(page.rows.map((r) => [r.id, r.clipUrl]));
    expect(clip).toEqual({
      evt_snap_odd: '/media/clips/evt_snap_odd',
      evt_snap_plain: '/media/clips/evt_snap_plain',
      evt_clip_off: null,
      evt_clip_none: null,
    });
  });

  it('limit 501 → 400 VALIDATION_FAILED; a tampered cursor → 400 VALIDATION_FAILED', async () => {
    for (const query of [
      { limit: '501' },
      { limit: '0' },
      { limit: 'many' },
      { cursor: 'tampered' },
      {
        cursor: Buffer.from(JSON.stringify({ t: 'x', id: 1 })).toString(
          'base64url',
        ),
      },
    ]) {
      for (const get of [getEvents, getIntervals]) {
        const res = await get(query).expect(400);
        expect([query, (res.body as { code: string }).code]).toEqual([
          query,
          'VALIDATION_FAILED',
        ]);
      }
    }
    // the maximum is fine
    await getEvents({ limit: '500' }).expect(200);
  });

  it('system events are left out unless useCase=system or types names a system type', async () => {
    const plain = await events({});
    expect(plain.rows.some((r) => r.useCase === 'system')).toBe(false);
    expect(ids(await events({ useCase: 'system' }))).toEqual(['evt_system']);
    const named = await events({ types: 'engine_started' });
    expect(ids(named)).toEqual(['evt_system']);
    expect(named.rows[0]).toMatchObject({ cameraId: null, cameraName: null });
  });

  it('an open interval has end null and durationSec null', async () => {
    const page = await intervals({ cameraIds: 'ivs', kind: 'desk_unattended' });
    expect(ids(page)).toEqual(['ses_closed', 'ses_open']);
    expect(page.rows[1]).toMatchObject({
      id: 'ses_open',
      cameraId: 'ivs',
      cameraName: 'ivs',
      useCase: 'cashier_presence',
      kind: 'desk_unattended',
      subjectId: null,
      start: '2026-10-14T15:00:00.000Z',
      end: null,
      endReason: null,
      durationSec: null,
    });
    expect(page.rows[0]).toMatchObject({
      end: '2026-10-14T15:20:00.000Z',
      endReason: 'returned',
      durationSec: 600,
    });
  });

  it('intervals are listed by start, page with a cursor, and keep camera_offline out unless asked for', async () => {
    const first = await intervals({ cameraIds: 'ivs', limit: '2' });
    expect(ids(first)).toEqual(['ses_closed', 'ses_table']);
    const second = await intervals({
      cameraIds: 'ivs',
      limit: '2',
      cursor: first.nextCursor as string,
    });
    // ses_before started before the range; ses_offline is a system interval
    expect(ids(second)).toEqual(['ses_open']);
    expect(second.nextCursor).toBeNull();

    expect(
      ids(await intervals({ cameraIds: 'ivs', kind: 'camera_offline' })),
    ).toEqual(['ses_offline']);
    expect(
      ids(await intervals({ cameraIds: 'ivs', useCase: 'system' })),
    ).toEqual(['ses_offline']);
    const table = await intervals({ cameraIds: 'ivs', kind: 'table_session' });
    expect(table.rows[0]).toMatchObject({
      subjectId: 'T1',
      data: { tableName: 'Table 1' },
      durationSec: 1200,
    });
  });

  it('a USER may list; without a session → 401', async () => {
    await getEvents({}).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/events')
      .query(DAY)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/intervals')
      .query(DAY)
      .expect(401);
  });
});
