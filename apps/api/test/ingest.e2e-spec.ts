import { INestApplication, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { App } from 'supertest/types';
import { IngestService } from '../src/ingest/ingest.service';
import { REDIS } from '../src/redis/redis.module';
import { createTestApp } from './app';
import {
  closeMsg,
  engineStarted,
  eventMsg,
  metricMsg,
  type Msg,
  openMsg,
  xadd,
} from './helpers/messages';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type IntervalRow = {
  id: string;
  end: Date | null;
  endReason: string | null;
  data: unknown;
};

describe('ingest: the events stream into Postgres', () => {
  let apps: INestApplication<App>[] = [];
  let redis: Redis;
  let warn: jest.SpyInstance;

  const start = async (INGEST: 'on' | 'off' = 'on') => {
    const app = await createTestApp({ INGEST });
    apps.push(app);
    return app;
  };

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    await seedCamera('cam_a', 'default');
    await seedCamera('cam_b', 'g2');
    redis = new Redis(process.env.REDIS_URL as string);
    // dead letters log a warning each; keep the output clean and let tests assert them
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
    await redis.quit();
    warn.mockRestore();
  });

  async function seedCamera(id: string, engineGroup: string): Promise<void> {
    await ownerQuery(
      `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "engineGroup", "activeVersion", "updatedAt")
       VALUES ($1, $1, 'cashier_presence', 'FILE', 'enc', $2, 1, now())`,
      id,
      engineGroup,
    );
  }

  async function waitFor<T>(
    probe: () => Promise<T | false | undefined>,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits until group `api` has read and acked every entry of `events`. */
  const drained = () =>
    waitFor(async () => {
      const groups = (await redis
        .xinfo('GROUPS', 'events')
        .catch(() => [])) as unknown[][];
      const api = groups
        .map((flat) => {
          const info: Record<string, unknown> = {};
          for (let i = 0; i < flat.length; i += 2) {
            info[flat[i] as string] = flat[i + 1];
          }
          return info;
        })
        .find((g) => g.name === 'api');
      return api?.lag === 0 && api.pending === 0;
    }, 'the api group to drain the stream');

  const pendingCount = async () =>
    ((await redis.xpending('events', 'api')) as [number])[0];

  const count = async (table: string) =>
    Number(
      (
        (await ownerQuery(`SELECT count(*) AS n FROM "${table}"`)) as {
          n: string;
        }[]
      )[0].n,
    );

  const intervals = async (...ids: string[]) =>
    (await ownerQuery(
      `SELECT "id", "end", "endReason", "data" FROM "Interval" WHERE "id" = ANY($1)`,
      ids,
    )) as IntervalRow[];

  const interval = async (id: string) => (await intervals(id))[0];

  const deadEvents = async () =>
    (await ownerQuery(
      `SELECT "streamId", "payload", "reason" FROM "DeadEvent" ORDER BY "id"`,
    )) as { streamId: string; payload: string; reason: string }[];

  const entry = (id: string, msg: Msg) => ({ id, msg: JSON.stringify(msg) });

  it('an event lands once when the same message is XADDed twice', async () => {
    await start();
    const msg = eventMsg();
    await xadd(msg);
    await xadd(msg);
    await drained();

    const rows = await ownerQuery(`SELECT "id" FROM "Event"`);
    expect(rows).toEqual([{ id: msg.id }]);
    expect(await count('DeadEvent')).toBe(0);
  });

  it('processBatch twice with the same entries leaves one Event, one Interval and the metric value unchanged', async () => {
    const app = await start();
    const ingest = app.get(IngestService);
    const entries = [
      entry('1-1', eventMsg()),
      entry('1-2', openMsg()),
      entry('1-3', metricMsg({ value: 4 })),
    ];

    await ingest.processBatch(entries);
    await ingest.processBatch(entries);

    expect(await count('Event')).toBe(1);
    expect(await count('Interval')).toBe(1);
    expect(await ownerQuery(`SELECT "value" FROM "Metric"`)).toEqual([
      { value: 4 },
    ]);
    expect(await count('DeadEvent')).toBe(0);
  });

  it('pending entries are processed on start', async () => {
    const off = await start('off');
    const offRedis = off.get<Redis>(REDIS);
    await offRedis.xgroup('CREATE', 'events', 'api', '0', 'MKSTREAM');
    const msg = eventMsg();
    await xadd(msg);
    const read = await offRedis.xreadgroup(
      'GROUP',
      'api',
      'api-1',
      'COUNT',
      10,
      'STREAMS',
      'events',
      '>',
    );
    expect(read).toHaveLength(1);
    expect(await pendingCount()).toBe(1);

    await start('on');

    await waitFor(
      async () =>
        (await ownerQuery(`SELECT 1 FROM "Event" WHERE "id" = $1`, msg.id))
          .length === 1,
      'the pending event to land',
    );
    await waitFor(
      async () => (await pendingCount()) === 0,
      'the pending entry to be acked',
    );
  });

  it('invalid JSON, unknown use case, bad data and unknown camera each become one DeadEvent with a reason; a valid message XADDed after them still lands', async () => {
    await start();
    const unknownUseCase = { ...eventMsg(), useCase: 'unknown_uc' };
    const badData = { ...eventMsg(), data: { absentSec: -1 } };
    const unknownCamera = eventMsg({ cameraId: 'cam_missing' });
    const ok = eventMsg();

    const ids = [
      await xadd('{not json'),
      await xadd(unknownUseCase),
      await xadd(badData),
      await xadd(unknownCamera),
    ];
    await xadd(ok);
    await drained();

    expect(await ownerQuery(`SELECT "id" FROM "Event"`)).toEqual([
      { id: ok.id },
    ]);
    expect(await deadEvents()).toEqual([
      { streamId: ids[0], payload: '{not json', reason: 'invalid JSON' },
      {
        streamId: ids[1],
        payload: JSON.stringify(unknownUseCase),
        reason: "/useCase: unknown use case 'unknown_uc'",
      },
      {
        streamId: ids[2],
        payload: JSON.stringify(badData),
        reason: '/data/absentSec: must be >= 0',
      },
      {
        streamId: ids[3],
        payload: JSON.stringify(unknownCamera),
        reason: 'unknown camera cam_missing',
      },
    ]);
    // one warning per dead letter, naming the stream id and the reason
    const warnings = warn.mock.calls.map(([m]) => String(m));
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain(ids[0]);
    expect(warnings[0]).toContain('invalid JSON');
    expect(warnings[3]).toContain(ids[3]);
    expect(warnings[3]).toContain('unknown camera cam_missing');
  });

  it('interval open then close sets end and endReason, and merges data', async () => {
    await start();
    const kept = openMsg({ data: { tableName: 'Table 1' } });
    const renamed = openMsg({
      subjectId: 'T2',
      data: { tableName: 'Table 2' },
    });
    await xadd(kept);
    await xadd(renamed);
    await xadd(closeMsg({ sessionId: kept.sessionId, data: {} }));
    await xadd(
      closeMsg({
        sessionId: renamed.sessionId,
        time: '2026-10-09T10:07:30.250Z',
        endReason: 'engine_stop',
        data: { tableName: 'Table 2b' },
      }),
    );
    await drained();

    expect(await interval(kept.sessionId as string)).toEqual({
      id: kept.sessionId,
      end: new Date('2026-10-09T10:05:00.000Z'),
      endReason: 'ended',
      data: { tableName: 'Table 1' },
    });
    expect(await interval(renamed.sessionId as string)).toEqual({
      id: renamed.sessionId,
      end: new Date('2026-10-09T10:07:30.250Z'),
      endReason: 'engine_stop',
      data: { tableName: 'Table 2b' },
    });
  });

  it('close for an unknown session → DeadEvent; closing twice changes nothing', async () => {
    await start();
    const unknown = closeMsg();
    const open = openMsg();
    const unknownId = await xadd(unknown);
    await xadd(open);
    await xadd(
      closeMsg({ sessionId: open.sessionId, data: { tableName: 'first' } }),
    );
    await xadd(
      closeMsg({
        sessionId: open.sessionId,
        time: '2026-10-09T10:09:00.000Z',
        endReason: 'engine_stop',
        data: { tableName: 'second' },
      }),
    );
    await drained();

    expect(await deadEvents()).toEqual([
      {
        streamId: unknownId,
        payload: JSON.stringify(unknown),
        reason: `close for unknown interval ${unknown.sessionId as string}`,
      },
    ]);
    expect(await interval(open.sessionId as string)).toEqual({
      id: open.sessionId,
      end: new Date('2026-10-09T10:05:00.000Z'),
      endReason: 'ended',
      data: { tableName: 'first' },
    });
  });

  it('metric for the same minute twice keeps the last value', async () => {
    await start();
    await xadd(metricMsg({ value: 1 }));
    await xadd(metricMsg({ value: 3 }));
    await drained();

    expect(
      await ownerQuery(
        `SELECT "cameraId", "name", "minute", "value" FROM "Metric"`,
      ),
    ).toEqual([
      {
        cameraId: 'cam_a',
        name: 'queue_length',
        minute: new Date('2026-10-09T10:00:00.000Z'),
        value: 3,
      },
    ]);
  });

  it(`engine_started {engineGroup: "default"} closes camera A's open interval (group default) with engine_restart at the event time, leaves camera B's (group g2) open and leaves A's interval opened after it open`, async () => {
    await start();
    const a = openMsg({ cameraId: 'cam_a', time: '2026-10-09T09:00:00.000Z' });
    const b = openMsg({ cameraId: 'cam_b', time: '2026-10-09T09:00:00.000Z' });
    const aLater = openMsg({
      cameraId: 'cam_a',
      time: '2026-10-09T10:00:01.000Z',
    });
    await xadd(a);
    await xadd(b);
    await xadd(engineStarted('default', '2026-10-09T10:00:00.500Z'));
    await xadd(aLater);
    await drained();

    const rows = await intervals(
      a.sessionId as string,
      b.sessionId as string,
      aLater.sessionId as string,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.sessionId as string)).toMatchObject({
      end: new Date('2026-10-09T10:00:00.500Z'),
      endReason: 'engine_restart',
    });
    expect(byId.get(b.sessionId as string)).toMatchObject({
      end: null,
      endReason: null,
    });
    expect(byId.get(aLater.sessionId as string)).toMatchObject({
      end: null,
      endReason: null,
    });
  });

  it('a redelivered engine_started does not close intervals opened after it', async () => {
    const app = await start();
    const ingest = app.get(IngestService);
    const started = entry('1-1', engineStarted('default'));
    const openNew = openMsg({ time: '2026-10-09T10:00:01.000Z' });

    await ingest.processBatch([started, entry('1-2', openNew)]);
    await ingest.processBatch([started]);

    expect(await interval(openNew.sessionId as string)).toMatchObject({
      end: null,
      endReason: null,
    });
    expect(await count('Event')).toBe(1);
  });

  it('while Postgres is unreachable nothing is acked, counted or dead-lettered, and the consumer keeps retrying', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const unreachable = new URL(process.env.DATABASE_URL as string);
    unreachable.port = '1';
    const app = await createTestApp({
      INGEST: 'on',
      DATABASE_URL: unreachable.toString(),
    });
    try {
      // with the database up this would be dead-lettered and acked at once
      await xadd('{not json');

      await waitFor(
        () => Promise.resolve(error.mock.calls.length >= 2),
        'a failed batch and a failed retry',
      );

      const messages = (error.mock.calls as [string][]).map(([m]) => m);
      expect(messages[0]).toMatch(/^ingest failed, retrying in 1 s: /);
      expect(messages[1]).toMatch(/^ingest failed, retrying in 2 s: /);
      expect(await pendingCount()).toBe(1);
      expect(await redis.hlen('ingest:failures')).toBe(0);
      expect(await count('DeadEvent')).toBe(0);
    } finally {
      await app.close();
      error.mockRestore();
    }
  });
});
