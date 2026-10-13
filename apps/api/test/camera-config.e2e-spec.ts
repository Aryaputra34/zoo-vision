import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Json = Record<string, unknown>;
type Cfg = {
  settings: Record<string, unknown>;
  note: string | null;
  author: Record<string, unknown>;
  schemaVersion: number;
  changes: { path: string }[];
};

describe('camera config versions', () => {
  let app: INestApplication<App>;
  let manager: string;
  let superadmin: string;
  const settings = validSettings('cashier_presence');
  const movedZone = [
    [0.3, 0.4],
    [0.7, 0.4],
    [0.7, 0.9],
    [0.3, 0.9],
  ];

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    manager = (await asRole(app, 'MANAGER')).cookie;
    superadmin = (await asRole(app, 'SUPERADMIN')).cookie;
    await http()
      .post('/api/v1/cameras')
      .set('Cookie', superadmin)
      .send({
        id: 'cam_test_01',
        name: 'Cashier 1',
        useCase: 'cashier_presence',
        sourceType: 'RTSP',
        mainStreamUrl: 'rtsp://10.1.2.3/main',
        settings,
      })
      .expect(201);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const save = (cookie: string, payload: Json) =>
    http()
      .post('/api/v1/cameras/cam_test_01/config')
      .set('Cookie', cookie)
      .send(payload);
  const get = (cookie: string, path = '') =>
    http()
      .get(`/api/v1/cameras/cam_test_01/config${path}`)
      .set('Cookie', cookie);
  const versionCount = async () =>
    (await ownerQuery('SELECT * FROM "CameraConfigVersion"')).length;

  it('MANAGER saves a moved clerk_zone with baseVersion 1 → 201 {version: 2}; GET config returns v2; cfg:changed version 2', async () => {
    const messages: string[] = [];
    const sub = new Redis(process.env.REDIS_URL as string);
    sub.on('message', (_c, m: string) => messages.push(m));
    await sub.subscribe('cfg:changed');
    try {
      const res = await save(manager, {
        baseVersion: 1,
        settings: { ...settings, clerk_zone: movedZone },
        note: 'moved',
      }).expect(201);
      expect(res.body).toEqual({ version: 2 });
      const cfg = (await get(manager).expect(200)).body as Cfg;
      expect(cfg).toMatchObject({
        version: 2,
        useCase: 'cashier_presence',
        note: 'moved',
        author: { type: 'user', name: 'Test MANAGER' },
      });
      expect(cfg.settings.clerk_zone).toEqual(movedZone);
      expect(cfg.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(cfg).not.toHaveProperty('authorId');
      expect(cfg.author).not.toHaveProperty('id');
      for (let i = 0; i < 100 && messages.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(messages).toContain('{"cameraId":"cam_test_01","version":2}');
    } finally {
      await sub.quit();
    }
  });

  it('a USER may read the active config but not the version list or save', async () => {
    const usr = (await asRole(app, 'USER')).cookie;
    await get(usr).expect(200);
    await get(usr, '/versions').expect(403);
    await save(usr, { baseVersion: 1, settings }).expect(403);
  });

  it('a stale baseVersion → 409 naming the current version and no version 3', async () => {
    await save(manager, {
      baseVersion: 1,
      settings: { ...settings, clerk_zone: movedZone },
    }).expect(201);
    const res = await save(manager, { baseVersion: 1, settings }).expect(409);
    expect((res.body as Json).message).toContain('2');
    expect(await versionCount()).toBe(2);
  });

  it('the stale baseVersion check comes before the use-case check', async () => {
    await save(manager, {
      baseVersion: 7,
      useCase: 'vehicle_gate',
      settings,
    }).expect(409);
  });

  it('two saves with the same baseVersion at once (Promise.all) → one 201 and one 409', async () => {
    const statuses = (
      await Promise.all([
        save(manager, {
          baseVersion: 1,
          settings: { ...settings, clerk_zone: movedZone },
        }),
        save(manager, {
          baseVersion: 1,
          settings: { ...settings, debounce_alert_sec: 60 },
        }),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(await versionCount()).toBe(2);
  });

  it('MANAGER changing model_name → 403 fields ["/model_name"]; SUPERADMIN → 201', async () => {
    const changed = { ...settings, model_name: 'yolo11m.pt' };
    const res = await save(manager, {
      baseVersion: 1,
      settings: changed,
    }).expect(403);
    expect(res.body).toMatchObject({
      message: 'Only a superadmin can change: /model_name',
      fields: ['/model_name'],
    });
    await save(superadmin, { baseVersion: 1, settings: changed }).expect(201);
  });

  it('MANAGER changing useCase → 403; SUPERADMIN to vehicle_gate with valid gate settings → 201 and the camera useCase is vehicle_gate', async () => {
    const gate = validSettings('vehicle_gate');
    await save(manager, {
      baseVersion: 1,
      useCase: 'vehicle_gate',
      settings: gate,
    }).expect(403);
    await save(superadmin, {
      baseVersion: 1,
      useCase: 'vehicle_gate',
      settings: gate,
    }).expect(201);
    const rows = await ownerQuery(
      'SELECT "useCase", "activeVersion" FROM "Camera"',
    );
    expect(rows[0]).toMatchObject({
      useCase: 'vehicle_gate',
      activeVersion: 2,
    });
  });

  it('invalid settings → 400 with paths', async () => {
    const res = await save(manager, {
      baseVersion: 1,
      settings: { ...settings, absence_alert_timeout_sec: 0 },
    }).expect(400);
    const errors = (res.body as Json).errors as { path: string }[];
    expect(errors.map((e) => e.path)).toContain('/absence_alert_timeout_sec');
    expect(await versionCount()).toBe(1);
  });

  describe('rollback', () => {
    const rollback = (cookie: string, payload: Json) =>
      http()
        .post('/api/v1/cameras/cam_test_01/config/rollback')
        .set('Cookie', cookie)
        .send(payload);

    it('to v1 creates v3 equal to v1 with note "rollback to v1"; unknown version → 404', async () => {
      await save(manager, {
        baseVersion: 1,
        settings: { ...settings, clerk_zone: movedZone },
      }).expect(201);
      const res = await rollback(manager, {
        baseVersion: 2,
        version: 1,
      }).expect(201);
      expect(res.body).toEqual({ version: 3 });
      const v3 = (await get(manager, '/versions/3').expect(200)).body as Cfg;
      expect(v3.settings).toEqual(settings);
      expect(v3.note).toBe('rollback to v1');
      await rollback(manager, { baseVersion: 3, version: 99 }).expect(404);
    });

    it('a MANAGER rollback across a model_name change → 403', async () => {
      await save(superadmin, {
        baseVersion: 1,
        settings: { ...settings, model_name: 'yolo11m.pt' },
      }).expect(201);
      await rollback(manager, { baseVersion: 2, version: 1 }).expect(403);
      expect(await versionCount()).toBe(2);
    });

    it('audits camera_config.rollback', async () => {
      await rollback(manager, { baseVersion: 1, version: 1 }).expect(201);
      const rows = await ownerQuery(
        `SELECT * FROM "AuditLog" WHERE action = 'camera_config.rollback'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  it('versions list is newest first without settings; version 2 changes contain "/clerk_zone"', async () => {
    await save(manager, {
      baseVersion: 1,
      settings: { ...settings, clerk_zone: movedZone },
    }).expect(201);
    const list = (await get(manager, '/versions').expect(200)).body as (Json & {
      author: unknown;
    })[];
    expect(list.map((v) => v.version)).toEqual([2, 1]);
    expect(list[0]).not.toHaveProperty('settings');
    expect(list[0].author).toEqual({ type: 'user', name: 'Test MANAGER' });
    const v2 = (await get(manager, '/versions/2').expect(200)).body as Cfg;
    expect(v2.changes.map((c) => c.path)).toContain('/clerk_zone');
    const v1 = (await get(manager, '/versions/1').expect(200)).body as Cfg;
    expect(v1.changes).toEqual([]);
    await get(manager, '/versions/9').expect(404);
  });

  it('audit row camera_config.save has before.version 1 and after.version 2', async () => {
    await save(manager, {
      baseVersion: 1,
      settings: { ...settings, clerk_zone: movedZone },
    }).expect(201);
    const rows = await ownerQuery(
      `SELECT * FROM "AuditLog" WHERE action = 'camera_config.save'`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Json;
    expect(row.before).toMatchObject({
      version: 1,
      useCase: 'cashier_presence',
    });
    expect(row.after).toMatchObject({
      version: 2,
      useCase: 'cashier_presence',
    });
    expect(row.entityId).toBe('cam_test_01');
  });

  describe('model_id', () => {
    const insertModel = async (status: string) => {
      const [{ id }] = (await ownerQuery(
        `INSERT INTO "AiModel" (id, name, format, source, status, "filePath", "originalName", sha256, "updatedAt")
         VALUES (gen_random_uuid(), 'm', 'ONNX', 'UPLOAD', $1::"ModelStatus", 'registry/' || gen_random_uuid() || '.onnx', 'm.onnx', md5(random()::text), now())
         RETURNING id`,
        status,
      )) as { id: string }[];
      return id;
    };

    it('saving model_id of a VALIDATING model → 400 at /model_id; of a READY model → 201', async () => {
      const validating = await insertModel('VALIDATING');
      const res = await save(superadmin, {
        baseVersion: 1,
        settings: { ...settings, model_id: validating },
      }).expect(400);
      expect((res.body as { errors: unknown[] }).errors).toEqual([
        { path: '/model_id', message: expect.any(String) as string },
      ]);
      await save(superadmin, {
        baseVersion: 1,
        settings: {
          ...settings,
          model_id: '5f0e2a4c-1d3b-4c6e-8a7f-9b0c1d2e3f40',
        },
      }).expect(400);
      const ready = await insertModel('READY');
      await save(superadmin, {
        baseVersion: 1,
        settings: { ...settings, model_id: ready },
      }).expect(201);
    });

    it('creating a camera with the model_id of a non-READY model → 400', async () => {
      const failed = await insertModel('FAILED');
      await http()
        .post('/api/v1/cameras')
        .set('Cookie', superadmin)
        .send({
          id: 'cam_new',
          name: 'New',
          useCase: 'cashier_presence',
          sourceType: 'RTSP',
          mainStreamUrl: 'rtsp://10.1.2.3/main',
          settings: { ...settings, model_id: failed },
        })
        .expect(400);
    });

    it('a MANAGER sending model_id → 403 (x-minRole)', async () => {
      const ready = await insertModel('READY');
      await save(manager, {
        baseVersion: 1,
        settings: { ...settings, model_id: ready },
      }).expect(403);
    });

    it('keeping an unchanged model_id is accepted after the model was revalidated to FAILED', async () => {
      const ready = await insertModel('READY');
      await save(superadmin, {
        baseVersion: 1,
        settings: { ...settings, model_id: ready },
      }).expect(201);
      await ownerQuery(
        `UPDATE "AiModel" SET status = 'FAILED' WHERE id = $1`,
        ready,
      );
      await save(manager, {
        baseVersion: 2,
        settings: { ...settings, model_id: ready, clerk_zone: movedZone },
      }).expect(201);
    });
  });
});
