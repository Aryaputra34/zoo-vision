import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const URL_MAIN = 'rtsp://admin:hunter2pw@10.1.2.3:554/main';
const URL_SUB = 'rtsp://admin:hunter2pw@10.1.2.3:554/sub';

const body = (over: Record<string, unknown> = {}) => ({
  id: 'cam_test_01',
  name: 'Cashier 1',
  area: 'Shop',
  useCase: 'cashier_presence',
  sourceType: 'RTSP',
  mainStreamUrl: URL_MAIN,
  subStreamUrl: URL_SUB,
  targetFps: 5,
  settings: validSettings('cashier_presence'),
  ...over,
});

describe('cameras', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const create = async (over: Record<string, unknown> = {}) => {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    return http()
      .post('/api/v1/cameras')
      .set('Cookie', cookie)
      .send(body(over));
  };

  it('SUPERADMIN creates a cashier camera with the valid example settings → 201; the stored row contains no "rtsp://" and not the password', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'cam_test_01',
      activeVersion: 1,
      mainStreamUrl: URL_MAIN,
      subStreamUrl: URL_SUB,
      enabled: true,
    });
    const rows = await ownerQuery('SELECT * FROM "Camera"');
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('rtsp://');
    expect(text).not.toContain('hunter2pw');
    const versions = await prisma.cameraConfigVersion.findMany();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      useCase: 'cashier_presence',
      authorType: 'user',
      authorName: 'Test SUPERADMIN',
    });
    expect(versions[0].schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('accepts null for optional fields (import shape) and FILE sources', async () => {
    const res = await create({
      sourceType: 'FILE',
      mainStreamUrl: 'sample_data/cars.mp4',
      subStreamUrl: null,
      recordingPath: null,
      nxCameraId: null,
      area: null,
      enabled: false,
      targetFps: 2,
      recording: { retentionDays: null },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sourceType: 'FILE',
      mainStreamUrl: 'sample_data/cars.mp4',
      subStreamUrl: null,
      enabled: false,
      area: null,
      recording: { retentionDays: null },
    });
  });

  it('rejects a non-rtsp URL for a non-FILE camera without echoing it', async () => {
    const res = await create({ mainStreamUrl: 'http://secret-host/x' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });

  it('GET as MANAGER has no stream URLs; as SUPERADMIN shows them decrypted; as USER has no recording block', async () => {
    await create();
    await create({ id: 'cam_a_00' });
    const mgr = await asRole(app, 'MANAGER');
    const sa = await asRole(app, 'SUPERADMIN');
    const usr = await asRole(app, 'USER');

    const m = await http()
      .get('/api/v1/cameras/cam_test_01')
      .set('Cookie', mgr.cookie)
      .expect(200);
    expect(m.body).toHaveProperty('recording');
    expect(m.body).not.toHaveProperty('mainStreamUrl');
    expect(JSON.stringify(m.body)).not.toContain('rtsp');

    const s = await http()
      .get('/api/v1/cameras/cam_test_01')
      .set('Cookie', sa.cookie)
      .expect(200);
    expect(s.body).toMatchObject({ mainStreamUrl: URL_MAIN });

    const u = await http()
      .get('/api/v1/cameras')
      .set('Cookie', usr.cookie)
      .expect(200);
    const list = u.body as { id: string }[];
    expect(list.map((c) => c.id)).toEqual(['cam_a_00', 'cam_test_01']);
    expect(list[0]).not.toHaveProperty('recording');
    expect(list[0]).not.toHaveProperty('targetFps');

    await http()
      .get('/api/v1/cameras/nope_cam')
      .set('Cookie', usr.cookie)
      .expect(404);
    await http().get('/api/v1/cameras').expect(401);
  });

  it('settings with clerk_zone point 1.2 → 400 with errors[0].path "/clerk_zone/0/0"', async () => {
    const settings = validSettings('cashier_presence');
    (settings.clerk_zone as number[][])[0][0] = 1.2;
    const res = await create({ settings });
    expect(res.status).toBe(400);
    const b = res.body as { errors: { path: string }[] };
    expect(b.errors[0].path).toBe('/clerk_zone/0/0');
    expect(await prisma.camera.count()).toBe(0);
  });

  it('useCase "system" or "nope" → 400', async () => {
    expect((await create({ useCase: 'system' })).status).toBe(400);
    expect((await create({ useCase: 'nope' })).status).toBe(400);
  });

  it('duplicate id → 409', async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });

  it('MANAGER PATCH {name} → 200; {targetFps: 12} → 403 ROLE_REQUIRED at /targetFps; {name, targetFps: <unchanged>} → 200', async () => {
    await create();
    const { cookie } = await asRole(app, 'MANAGER');
    const patch = (b: object, id = 'cam_test_01') =>
      http().patch(`/api/v1/cameras/${id}`).set('Cookie', cookie).send(b);

    const ok = await patch({ name: 'Renamed' }).expect(200);
    expect(ok.body).toMatchObject({ name: 'Renamed' });
    expect(ok.body).not.toHaveProperty('mainStreamUrl');

    const denied = await patch({ targetFps: 12 }).expect(403);
    expect(denied.body).toMatchObject({
      code: 'ROLE_REQUIRED',
      errors: [{ path: '/targetFps', message: 'needs SUPERADMIN' }],
    });
    const row = await prisma.camera.findUniqueOrThrow({
      where: { id: 'cam_test_01' },
    });
    expect(row.targetFps).toBe(5);

    await patch({ name: 'Again', targetFps: 5 }).expect(200);
    // URLs are never compared for a manager: any value is 403, so no equality oracle
    for (const b of [
      { mainStreamUrl: URL_MAIN },
      { mainStreamUrl: URL_SUB },
      { subStreamUrl: URL_SUB },
      { subStreamUrl: null },
    ]) {
      const r = await patch(b).expect(403);
      expect(
        (r.body as { errors: { path: string }[] }).errors.map((e) => e.path),
      ).toEqual(Object.keys(b).map((k) => `/${k}`));
    }
    await patch({ id: 'x' }).expect(400);
    await patch({ name: 'x' }, 'nope_cam').expect(404);
  });

  it('MANAGER PATCH {inferenceStream: "SUB"} → 403 ROLE_REQUIRED at /inferenceStream; SUPERADMIN → 200 and cfg:changed is published', async () => {
    await create();
    const sub = new Redis(process.env.REDIS_URL as string);
    const messages: string[] = [];
    sub.on('message', (_c, m: string) => messages.push(m));
    await sub.subscribe('cfg:changed');
    try {
      const mgr = await asRole(app, 'MANAGER');
      const denied = await http()
        .patch('/api/v1/cameras/cam_test_01')
        .set('Cookie', mgr.cookie)
        .send({ inferenceStream: 'SUB' })
        .expect(403);
      expect(
        (denied.body as { errors: { path: string }[] }).errors.map(
          (e) => e.path,
        ),
      ).toEqual(['/inferenceStream']);

      const admin = await asRole(app, 'SUPERADMIN');
      const res = await http()
        .patch('/api/v1/cameras/cam_test_01')
        .set('Cookie', admin.cookie)
        .send({ inferenceStream: 'SUB' })
        .expect(200);
      expect(res.body).toMatchObject({ inferenceStream: 'SUB' });
      for (let i = 0; i < 100 && messages.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(messages).toEqual(['{"cameraId":"cam_test_01","version":1}']);
      const view = await http()
        .get('/api/v1/cameras/cam_test_01')
        .set('Cookie', mgr.cookie)
        .expect(200);
      expect(view.body).toMatchObject({ inferenceStream: 'SUB' });
    } finally {
      await sub.quit();
    }
  });

  it('SUPERADMIN PATCH changes URLs and clears nullable fields; audit has streamUrlsChanged', async () => {
    await create();
    const { cookie } = await asRole(app, 'SUPERADMIN');
    const res = await http()
      .patch('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .send({
        mainStreamUrl: 'rtsp://other:newpw123@10.9.9.9/x',
        subStreamUrl: null,
        area: null,
        recording: { retentionDays: 30, stream: 'SUB' },
      })
      .expect(200);
    expect(res.body).toMatchObject({
      mainStreamUrl: 'rtsp://other:newpw123@10.9.9.9/x',
      subStreamUrl: null,
      area: null,
      recording: { retentionDays: 30, stream: 'SUB', enabled: true },
    });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'camera.update' },
    });
    expect(row.after).toMatchObject({
      streamUrlsChanged: true,
      mainStreamUrl: '[redacted]',
      subStreamUrl: '[redacted]',
    });
    expect(row.before).toMatchObject({ mainStreamUrl: '[redacted]' });
  });

  it('USER PATCH → 403; MANAGER POST → 403', async () => {
    await create();
    const usr = await asRole(app, 'USER');
    const mgr = await asRole(app, 'MANAGER');
    await http()
      .patch('/api/v1/cameras/cam_test_01')
      .set('Cookie', usr.cookie)
      .send({ name: 'x' })
      .expect(403);
    await http()
      .post('/api/v1/cameras')
      .set('Cookie', mgr.cookie)
      .send(body({ id: 'cam_other' }))
      .expect(403);
  });

  describe('cfg:changed', () => {
    let sub: Redis;
    const messages: string[] = [];

    beforeEach(async () => {
      messages.length = 0;
      sub = new Redis(process.env.REDIS_URL as string);
      sub.on('message', (_c, m: string) => messages.push(m));
      await sub.subscribe('cfg:changed');
    });
    afterEach(async () => {
      await sub.quit();
    });

    const waitFor = async (n: number) => {
      for (let i = 0; i < 100 && messages.length < n; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    it('create publishes cfg:changed {"cameraId":"cam_test_01","version":1}; update repeats it; delete publishes version null', async () => {
      await create();
      await waitFor(1);
      expect(messages[0]).toBe('{"cameraId":"cam_test_01","version":1}');

      const { cookie } = await asRole(app, 'SUPERADMIN');
      await http()
        .patch('/api/v1/cameras/cam_test_01')
        .set('Cookie', cookie)
        .send({ enabled: false })
        .expect(200);
      await http()
        .delete('/api/v1/cameras/cam_test_01')
        .set('Cookie', cookie)
        .expect(204);
      await waitFor(3);
      expect(messages).toEqual([
        '{"cameraId":"cam_test_01","version":1}',
        '{"cameraId":"cam_test_01","version":1}',
        '{"cameraId":"cam_test_01","version":null}',
      ]);
    });
  });

  it('DELETE with an Event row → 409; without → 204 and no versions left', async () => {
    await create();
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await ownerQuery(
      `INSERT INTO "Event" (id, time, "cameraId", "useCase", type, severity, "schemaVersion", data)
       VALUES ('evt_1', now(), 'cam_test_01', 'cashier_presence', 'x', 'info', 1, '{}')`,
    );
    const res = await http()
      .delete('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Camera has analytics data; disable it instead',
    );
    expect(await prisma.camera.count()).toBe(1);

    await ownerQuery(`DELETE FROM "Event"`);
    await http()
      .delete('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .expect(204);
    expect(await prisma.camera.count()).toBe(0);
    expect(await prisma.cameraConfigVersion.count()).toBe(0);
    await http()
      .delete('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .expect(404);
    const mgr = await asRole(app, 'MANAGER');
    await http()
      .delete('/api/v1/cameras/cam_test_01')
      .set('Cookie', mgr.cookie)
      .expect(403);
  });

  it('no audit row for cameras contains the plain URL', async () => {
    await create();
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await http()
      .patch('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .send({ mainStreamUrl: 'rtsp://a:zzpw99@h/y' })
      .expect(200);
    await http()
      .delete('/api/v1/cameras/cam_test_01')
      .set('Cookie', cookie)
      .expect(204);
    const rows = await prisma.auditLog.findMany();
    expect(rows.map((r) => r.action)).toEqual([
      'camera.create',
      'camera.update',
      'camera.delete',
    ]);
    const text = JSON.stringify(rows, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(text).not.toMatch(/rtsp:|hunter2pw|zzpw99/);
  });
});
