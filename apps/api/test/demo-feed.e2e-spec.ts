import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { runDemoFeed } from '../src/demo/demo-feed';
import { seedDemo } from '../src/demo/demo-seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, listenTestApp, TEST_ENGINE_TOKEN } from './app';
import { asRole } from './helpers/auth';
import { count } from './helpers/ingest';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

// each test may wait for the feed (the 30 s default is shorter than its own waits)
jest.setTimeout(60_000);

const PASSWORD = 'demo-password-123';
const FRAMES = join(__dirname, '..', 'demo', 'frames');

/** Polls `probe` every 50 ms until it is truthy; throws after `ms`. */
async function until<T>(
  probe: () => Promise<T | false | undefined | null>,
  what: string,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('demo feed', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let redis: Redis;
  let snapshots: string;
  let runs: { stop: () => Promise<void> }[];

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp({ INGEST: 'on' });
    baseUrl = await listenTestApp(app);
    await seedDemo(app, PASSWORD);
    redis = new Redis(process.env.REDIS_URL as string);
    snapshots = await mkdtemp(join(tmpdir(), 'zoo-demo-snapshots-'));
    runs = [];
  });

  afterEach(async () => {
    for (const run of runs) await run.stop();
    await redis.quit();
    await app.close();
    await rm(snapshots, { recursive: true, force: true });
  });

  const start = (
    over: { backfillDays?: number; resyncEveryMs?: number } = {},
  ) => {
    const controller = new AbortController();
    const done = runDemoFeed({
      redisUrl: process.env.REDIS_URL as string,
      apiUrl: baseUrl,
      engineToken: TEST_ENGINE_TOKEN,
      snapshotDir: snapshots,
      framesDir: FRAMES,
      backfillDays: 0,
      seed: 42,
      tz: 'Asia/Jakarta',
      signal: controller.signal,
      // the clock decides who is silent: the tests must not depend on it
      silence: false,
      ...over,
    });
    const run = {
      stop: async () => {
        controller.abort();
        await done;
      },
    };
    runs.push(run);
    return run;
  };

  it('a 1-day backfill lands in Event, Interval and Metric through the ingest; a second run does not backfill again', async () => {
    const first = start({ backfillDays: 1 });
    await until(
      async () => (await redis.exists('demo:backfilled')) === 1,
      'the backfill marker',
    );
    await until(
      async () =>
        (await count('Event')) > 0 &&
        (await count('Interval')) > 0 &&
        (await count('Metric')) > 0,
      'rows in Event, Interval and Metric',
    );
    // the stream is drained: nothing the feed wrote is left unread
    await until(async () => {
      const groups = (await redis.xinfo('GROUPS', 'events')) as unknown[][];
      const flat = groups[0] ?? [];
      const info: Record<string, unknown> = {};
      for (let i = 0; i < flat.length; i += 2)
        info[flat[i] as string] = flat[i + 1];
      return info.lag === 0 && info.pending === 0;
    }, 'the stream to drain');
    expect(await count('DeadEvent')).toBe(0);
    await first.stop();

    const before = await redis.xlen('events');
    const second = start({ backfillDays: 1 });
    await until(
      async () => (await redis.xlen('events')) > before,
      'engine_started',
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await second.stop();

    // a second backfill would add thousands; the restart adds engine_started and a few live messages
    expect((await redis.xlen('events')) - before).toBeLessThan(50);
    // every close had its open: the feed never sent an interval it could not account for
    expect(await count('DeadEvent')).toBe(0);
  }, 120_000);

  it('cam:demo_vehicle_gate:status has appliedVersion = activeVersion, and cam:demo_vehicle_gate:frame exists', async () => {
    start();

    const status = await until(async () => {
      const hash = await redis.hgetall('cam:demo_vehicle_gate:status');
      return hash.appliedVersion ? hash : null;
    }, 'the status hash');
    const camera = await app
      .get(PrismaService)
      .camera.findUniqueOrThrow({ where: { id: 'demo_vehicle_gate' } });

    expect(status).toMatchObject({
      state: 'running',
      appliedVersion: String(camera.activeVersion),
      engineGroup: 'demo',
      useCase: 'vehicle_gate',
    });
    expect(await redis.pttl('cam:demo_vehicle_gate:status')).toBeGreaterThan(0);
    await until(
      async () => (await redis.exists('cam:demo_vehicle_gate:frame')) === 1,
      'the frame',
    );
    const jpeg = await redis.getBuffer('cam:demo_vehicle_gate:frame');
    expect(jpeg?.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('a config saved for demo_horse_riding shows in its status appliedVersion within 3 s', async () => {
    start();
    await until(async () => {
      const hash = await redis.hgetall('cam:demo_horse_riding:status');
      return hash.appliedVersion === '1' ? hash : null;
    }, 'the first status');
    const { cookie } = await asRole(app, 'SUPERADMIN');
    const http = () => request(app.getHttpServer());
    const active = (
      await http()
        .get('/api/v1/cameras/demo_horse_riding/config')
        .set('Cookie', cookie)
        .expect(200)
    ).body as { settings: Record<string, unknown> };

    await http()
      .post('/api/v1/cameras/demo_horse_riding/config')
      .set('Cookie', cookie)
      .send({
        baseVersion: 1,
        settings: { ...active.settings, trace_length: 33 },
      })
      .expect(201);

    await until(
      async () =>
        (await redis.hget('cam:demo_horse_riding:status', 'appliedVersion')) ===
        '2',
      'appliedVersion 2',
      3_000,
    );
  });

  it('a config change whose cfg:changed notice was lost is found by the periodic resync', async () => {
    start({ resyncEveryMs: 500 });
    await until(async () => {
      const hash = await redis.hgetall('cam:demo_cashier_presence:status');
      return hash.appliedVersion === '1' ? hash : null;
    }, 'the first status');

    // version 2 appears in the database with no notice published, as when a notice is lost
    await ownerQuery(
      `INSERT INTO "CameraConfigVersion"
         ("cameraId", "version", "useCase", "settings", "schemaVersion", "authorType", "authorId", "authorName", "createdAt")
       SELECT "cameraId", 2, "useCase", "settings", "schemaVersion", "authorType", "authorId", "authorName", now()
       FROM "CameraConfigVersion" WHERE "cameraId" = 'demo_cashier_presence' AND "version" = 1`,
    );
    await ownerQuery(
      `UPDATE "Camera" SET "activeVersion" = 2 WHERE "id" = 'demo_cashier_presence'`,
    );

    await until(
      async () =>
        (await redis.hget(
          'cam:demo_cashier_presence:status',
          'appliedVersion',
        )) === '2',
      'appliedVersion 2 without a notice',
      5_000,
    );
  });
});
