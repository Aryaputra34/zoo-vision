import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { IngestService } from '../src/ingest/ingest.service';
import { OfflineJob } from '../src/jobs/offline.job';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { engineStarted } from './helpers/messages';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Row = {
  cameraId: string;
  useCase: string;
  kind: string;
  subjectId: string | null;
  end: Date | null;
  endReason: string | null;
  configVersion: number | null;
  schemaVersion: number;
  data: unknown;
};

describe('OfflineJob: camera_offline intervals', () => {
  let app: INestApplication<App>;
  let redis: Redis;

  const tick = (now?: Date) => app.get(OfflineJob).tick(now);
  const seedCamera = (id: string, enabled = true) =>
    ownerQuery(
      `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "enabled", "activeVersion", "updatedAt")
       VALUES ($1, $1, 'cashier_presence', 'FILE', 'enc', $2, 1, now())`,
      id,
      enabled,
    );
  const rows = async () =>
    (await ownerQuery(
      `SELECT "cameraId", "useCase", "kind", "subjectId", "end", "endReason", "configVersion", "schemaVersion", "data"
         FROM "Interval" ORDER BY "start", "cameraId"`,
    )) as Row[];
  const online = (id: string) =>
    redis.hset(`cam:${id}:status`, { state: 'running' });

  /** The engine reported the camera once (the API sees the key), then the key expired. */
  const seenOnce = async (id: string, now?: Date) => {
    await redis.hset(`cam:${id}:status`, { state: 'starting' });
    await tick(now);
    await redis.del(`cam:${id}:status`);
  };

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    redis = new Redis(process.env.REDIS_URL as string);
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
    await redis.quit();
  });

  it('a camera no engine has reported yet gets no interval, and can be deleted', async () => {
    await seedCamera('cam_a');
    await tick();
    await tick();
    expect(await rows()).toHaveLength(0);
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await request(app.getHttpServer())
      .delete('/api/v1/cameras/cam_a')
      .set('Cookie', cookie)
      .expect(204);
  });

  it('a camera seen once whose key then disappears gets one open camera_offline interval (useCase system); a second tick adds none', async () => {
    await seedCamera('cam_a');
    await seenOnce('cam_a');
    await tick();
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      cameraId: 'cam_a',
      useCase: 'system',
      kind: 'camera_offline',
      subjectId: null,
      end: null,
      endReason: null,
      configVersion: null,
      data: {},
    });
    expect(found[0].schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('the key coming back closes it with endReason online; the key going away opens a new one', async () => {
    await seedCamera('cam_a');
    await seenOnce('cam_a');
    await tick();
    await online('cam_a');
    await tick();
    let found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ endReason: 'online' });
    expect(found[0].end).toBeInstanceOf(Date);

    await redis.del('cam:cam_a:status');
    await tick();
    found = await rows();
    expect(found).toHaveLength(2);
    expect(found.filter((r) => r.end === null)).toHaveLength(1);
  });

  it('disabling the camera closes its open interval with endReason disabled', async () => {
    await seedCamera('cam_a');
    await seenOnce('cam_a');
    await tick();
    await ownerQuery(`UPDATE "Camera" SET "enabled" = false`);
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ endReason: 'disabled' });
    expect(found[0].end).toBeInstanceOf(Date);
    await tick();
    expect(await rows()).toHaveLength(1);
  });

  it('a disabled camera without a status key gets no interval', async () => {
    await seedCamera('cam_a', false);
    await tick();
    expect(await rows()).toHaveLength(0);
  });

  it('engine_started for its group leaves the camera_offline interval open', async () => {
    await seedCamera('cam_a');
    await seenOnce('cam_a', new Date('2026-10-09T08:59:00.000Z'));
    await tick(new Date('2026-10-09T09:00:00.000Z'));
    const msg = engineStarted('default', '2026-10-09T10:00:00.000Z');
    await app
      .get(IngestService)
      .processBatch([{ id: '1-1', msg: JSON.stringify(msg) }]);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ end: null, endReason: null });
  });

  it('a never-connecting camera (key seen once as starting, then gone) opens an interval; a camera never seen and cameras with keys do not', async () => {
    await seedCamera('cam_a');
    await seedCamera('cam_b');
    await seedCamera('cam_c');
    await seedCamera('cam_d');
    await online('cam_b');
    await online('cam_c');
    await redis.hset('cam:cam_a:status', { state: 'starting' });
    await tick();
    await redis.del('cam:cam_a:status');
    await tick();
    const found = await rows();
    expect(found.map((r) => r.cameraId)).toEqual(['cam_a']);
  });

  it('firstSeenAt is set once, on the first tick that sees the key', async () => {
    await seedCamera('cam_a');
    await online('cam_a');
    const t1 = new Date('2026-10-09T09:00:00.000Z');
    await tick(t1);
    await tick(new Date('2026-10-09T09:05:00.000Z'));
    const [row] = (await ownerQuery(
      `SELECT "firstSeenAt" FROM "Camera" WHERE "id" = 'cam_a'`,
    )) as { firstSeenAt: Date }[];
    expect(row.firstSeenAt.toISOString()).toBe(t1.toISOString());
  });
});
