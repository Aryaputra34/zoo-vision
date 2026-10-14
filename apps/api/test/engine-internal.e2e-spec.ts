import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, TEST_ENGINE_TOKEN } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const MAIN = 'rtsp://admin:hunter2pw@10.1.2.3:554/main';
const SUB = 'rtsp://admin:hunter2pw@10.1.2.3:554/sub';

type EngineCamera = {
  id: string;
  version: number;
  schemaVersion: number;
  sourceUrl: string;
  settings: Record<string, any>;
  model: { path: string; imgsz: unknown };
  targetFps: number;
  nxCameraId: string | null;
};

describe('engine internal routes', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = `Bearer ${TEST_ENGINE_TOKEN}`;
  const snapshot = (group = 'default') =>
    http()
      .get('/internal/engine/cameras')
      .query({ group })
      .set('Authorization', bearer);
  const create = async (over: Record<string, unknown> = {}) => {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    return http()
      .post('/api/v1/cameras')
      .set('Cookie', cookie)
      .send({
        id: 'cam_a',
        name: 'Cam A',
        useCase: 'cashier_presence',
        sourceType: 'RTSP',
        mainStreamUrl: MAIN,
        subStreamUrl: SUB,
        settings: validSettings('cashier_presence'),
        ...over,
      })
      .expect(201);
  };
  const cameras = async (group?: string) =>
    ((await snapshot(group).expect(200)).body as { cameras: EngineCamera[] })
      .cameras;

  it('401 without a token, with a wrong token, and with only a SUPERADMIN session cookie', async () => {
    await http().get('/internal/engine/cameras?group=default').expect(401);
    await http()
      .get('/internal/engine/cameras?group=default')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await http()
      .get('/internal/engine/cameras?group=default')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('/api/internal/engine/cameras and /api/v1/internal/engine/cameras are 404', async () => {
    for (const path of [
      '/api/internal/engine/cameras',
      '/api/v1/internal/engine/cameras',
    ]) {
      await http()
        .get(`${path}?group=default`)
        .set('Authorization', bearer)
        .expect(404);
    }
  });

  it('400 for a missing group or "Bad Group"', async () => {
    await http()
      .get('/internal/engine/cameras')
      .set('Authorization', bearer)
      .expect(400);
    await snapshot('Bad Group').expect(400);
  });

  it('returns only enabled cameras of the group, sorted by id', async () => {
    await create({ id: 'cam_c' });
    await create({ id: 'cam_b' });
    await create({ id: 'cam_off', enabled: false });
    await create({ id: 'cam_other', engineGroup: 'second' });
    await create({ id: 'cam_a', engineGroup: 'default' });
    expect((await cameras()).map((c) => c.id)).toEqual([
      'cam_a',
      'cam_b',
      'cam_c',
    ]);
    expect((await cameras('second')).map((c) => c.id)).toEqual(['cam_other']);
    expect(await cameras('empty')).toEqual([]);
  });

  it('fills schema defaults: a horse camera saved without tripwire gets {enabled:false,start:[0.2,0.6],end:[0.8,0.6]}', async () => {
    const settings = validSettings('horse_riding');
    delete settings.tripwire;
    await create({ id: 'cam_horse', useCase: 'horse_riding', settings });
    const [cam] = await cameras();
    expect(cam.settings.tripwire).toEqual({
      enabled: false,
      start: [0.2, 0.6],
      end: [0.8, 0.6],
    });
    expect(cam.version).toBe(1);
    expect(cam.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('the snapshot entry for the fixture camera deep-equals fixture.engineCamera', async () => {
    // packages/contracts/fixtures/engine-camera.json: the engine's tests parse the same entry
    const fixture = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../packages/contracts/fixtures/engine-camera.json',
        ),
        'utf8',
      ),
    ) as {
      camera: Record<string, unknown>;
      settings: Record<string, unknown>;
      engineCamera: EngineCamera;
    };
    await create({ ...fixture.camera, settings: fixture.settings });

    const entry = (await cameras()).find((c) => c.id === fixture.camera.id);

    expect(entry).toEqual(fixture.engineCamera);
  });

  it('sourceUrl is the decrypted main URL; SUB uses the sub URL, and SUB without a sub URL falls back to main', async () => {
    await create({ id: 'cam_main' });
    await create({ id: 'cam_sub', inferenceStream: 'SUB' });
    await create({
      id: 'cam_nosub',
      inferenceStream: 'SUB',
      subStreamUrl: undefined,
    });
    const byId = Object.fromEntries(
      (await cameras()).map((c) => [c.id, c.sourceUrl]),
    );
    expect(byId).toEqual({ cam_main: MAIN, cam_sub: SUB, cam_nosub: MAIN });
  });

  it('model is {path: settings.model_name, imgsz: settings.imgsz}', async () => {
    const settings = {
      ...validSettings('cashier_presence'),
      model_name: 'custom.onnx',
      imgsz: 960,
    };
    await create({ settings, targetFps: 3, nxCameraId: 'nx-1' });
    const [cam] = await cameras();
    expect(cam.model).toEqual({ path: 'custom.onnx', imgsz: 960 });
    expect(cam.targetFps).toBe(3);
    expect(cam.nxCameraId).toBe('nx-1');
  });

  it("model.path is the AiModel's registry path when model_id is set, else model_name", async () => {
    const [{ id, filePath }] = (await ownerQuery(
      `INSERT INTO "AiModel" (id, name, format, source, status, "filePath", "originalName", sha256, "updatedAt")
       VALUES (gen_random_uuid(), 'm', 'ONNX', 'UPLOAD', 'READY', 'registry/' || gen_random_uuid() || '.onnx', 'm.onnx', md5('x'), now())
       RETURNING id, "filePath"`,
    )) as { id: string; filePath: string }[];
    const settings = validSettings('cashier_presence');
    await create({ id: 'cam_plain', settings });
    await create({ id: 'cam_model', settings: { ...settings, model_id: id } });
    const byId = Object.fromEntries(
      (await cameras()).map((c) => [c.id, c.model.path]),
    );
    expect(byId).toEqual({
      cam_model: filePath,
      cam_plain: settings.model_name,
    });
  });
});
