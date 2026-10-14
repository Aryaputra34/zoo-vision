import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DEMO_GROUP } from '../src/demo/demo-cameras';
import { seedDemo } from '../src/demo/demo-seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, TEST_ENGINE_TOKEN } from './app';
import { flushRedis, resetDb } from './setup/db';

const PASSWORD = 'demo-password-123';
const CAMERA_IDS = [
  'demo_cashier_presence',
  'demo_horse_riding',
  'demo_restaurant_counter',
  'demo_restaurant_table',
  'demo_vehicle_gate',
];

describe('demo seed', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const engineCameras = (group: string) =>
    request(app.getHttpServer())
      .get(`/internal/engine/cameras?group=${group}`)
      .set('Authorization', `Bearer ${TEST_ENGINE_TOKEN}`)
      .expect(200);

  it('creates five cameras in group demo and three users with their roles; a second run creates nothing', async () => {
    const first = await seedDemo(app, PASSWORD);

    expect([...first.cameras].sort()).toEqual(CAMERA_IDS);
    expect([...first.users].sort()).toEqual([
      'demo-manager',
      'demo-superadmin',
      'demo-user',
    ]);
    const prisma = app.get(PrismaService);
    const cameras = await prisma.camera.findMany({ orderBy: { id: 'asc' } });
    expect(cameras.map((c) => [c.id, c.engineGroup, c.sourceType])).toEqual(
      CAMERA_IDS.map((id) => [id, DEMO_GROUP, 'FILE']),
    );
    expect(cameras.every((c) => c.enabled && c.targetFps === 5)).toBe(true);
    expect(
      Object.fromEntries(cameras.map((c) => [c.id, c.recordingPath])),
    ).toEqual({
      demo_cashier_presence: null,
      demo_horse_riding: 'demo_horse_riding',
      demo_restaurant_counter: null,
      demo_restaurant_table: null,
      demo_vehicle_gate: 'demo_vehicle_gate',
    });
    const users = await prisma.user.findMany({ orderBy: { username: 'asc' } });
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['demo-manager', 'MANAGER'],
      ['demo-superadmin', 'SUPERADMIN'],
      ['demo-user', 'USER'],
    ]);

    const second = await seedDemo(app, PASSWORD);
    expect(second).toEqual({ cameras: [], users: [] });
    expect(await prisma.camera.count()).toBe(5);
    expect(await prisma.user.count()).toBe(3);
  });

  it('GET /internal/engine/cameras?group=demo lists the five; group default lists none of them', async () => {
    await seedDemo(app, PASSWORD);

    const demo = (await engineCameras('demo')).body as {
      cameras: { id: string }[];
    };
    expect(demo.cameras.map((c) => c.id).sort()).toEqual(CAMERA_IDS);
    const other = (await engineCameras('default')).body as {
      cameras: { id: string }[];
    };
    expect(other.cameras.map((c) => c.id)).toEqual([]);
  });

  it('demo-manager can log in with the password', async () => {
    await seedDemo(app, PASSWORD);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'demo-manager', password: PASSWORD })
      .expect(200);

    expect(res.body).toMatchObject({
      username: 'demo-manager',
      role: 'MANAGER',
    });
  });
});
