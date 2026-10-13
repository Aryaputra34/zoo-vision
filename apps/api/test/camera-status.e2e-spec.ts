import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Body = { status: { live: unknown } | null };

describe('camera status and the latest frame', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let cookie: string;

  const http = () => request(app.getHttpServer());
  const seedCamera = (id: string) =>
    ownerQuery(
      `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "activeVersion", "updatedAt")
       VALUES ($1, $1, 'cashier_presence', 'FILE', 'enc', 1, now())`,
      id,
    );
  const status = (over: Record<string, string> = {}) => ({
    state: 'running',
    fps: '4.9',
    lastFrameAt: '1760000000000',
    appliedVersion: '13',
    configError: '',
    useCase: 'cashier_presence',
    engineGroup: 'default',
    bootId: 'abc',
    restarts: '2',
    live: '{"people":1}',
    updatedAt: '1760000000500',
    ...over,
  });

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    redis = new Redis(process.env.REDIS_URL as string);
    app = await createTestApp();
    ({ cookie } = await asRole(app, 'USER'));
    await seedCamera('cam_a');
    await seedCamera('cam_b');
  });

  afterEach(async () => {
    await app.close();
    await redis.quit();
  });

  it('a camera with a status hash → online true and parsed numbers; without one → online false, status null', async () => {
    await redis.hset('cam:cam_a:status', status());

    const a = await http()
      .get('/api/v1/cameras/cam_a/status')
      .set('Cookie', cookie)
      .expect(200);
    expect(a.body).toEqual({
      online: true,
      status: {
        state: 'running',
        fps: 4.9,
        lastFrameAt: 1760000000000,
        appliedVersion: 13,
        configError: null,
        restarts: 2,
        live: { people: 1 },
        updatedAt: 1760000000500,
      },
    });

    const b = await http()
      .get('/api/v1/cameras/cam_b/status')
      .set('Cookie', cookie)
      .expect(200);
    expect(b.body).toEqual({ online: false, status: null });

    await http()
      .get('/api/v1/cameras/nope/status')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('empty lastFrameAt and appliedVersion read as null; a configError is passed through', async () => {
    await redis.hset(
      'cam:cam_a:status',
      status({
        state: 'starting',
        lastFrameAt: '',
        appliedVersion: '',
        configError: 'v13 rejected: bad',
        live: '{}',
      }),
    );
    const res = await http()
      .get('/api/v1/cameras/cam_a/status')
      .set('Cookie', cookie)
      .expect(200);
    expect((res.body as Body).status).toMatchObject({
      state: 'starting',
      lastFrameAt: null,
      appliedVersion: null,
      configError: 'v13 rejected: bad',
      live: {},
    });
  });

  it('as USER, GET /camera-status lists every camera', async () => {
    await redis.hset('cam:cam_b:status', status());
    const res = await http()
      .get('/api/v1/camera-status')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toEqual([
      { cameraId: 'cam_a', online: false, status: null },
      {
        cameraId: 'cam_b',
        online: true,
        status: {
          state: 'running',
          fps: 4.9,
          lastFrameAt: 1760000000000,
          appliedVersion: 13,
          configError: null,
          restarts: 2,
          live: { people: 1 },
          updatedAt: 1760000000500,
        },
      },
    ]);
    await http().get('/api/v1/camera-status').expect(401);
  });

  it('GET /cameras/:id/frame returns the stored bytes as image/jpeg with no-store; 404 when the key is missing or the camera is unknown', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0xff]);
    await redis.set('cam:cam_a:frame', jpeg);
    await redis.set('cam:ghost:frame', jpeg);

    const res = await http()
      .get('/api/v1/cameras/cam_a/frame')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).equals(jpeg)).toBe(true);

    await http()
      .get('/api/v1/cameras/cam_b/frame')
      .set('Cookie', cookie)
      .expect(404);
    await http()
      .get('/api/v1/cameras/ghost/frame')
      .set('Cookie', cookie)
      .expect(404);
  });

  it("a live field that isn't JSON reads as {}", async () => {
    await redis.hset('cam:cam_a:status', status({ live: 'not json' }));
    await redis.hset('cam:cam_b:status', status({ live: '[1,2]' }));
    const a = await http()
      .get('/api/v1/cameras/cam_a/status')
      .set('Cookie', cookie)
      .expect(200);
    expect((a.body as Body).status?.live).toEqual({});
    const b = await http()
      .get('/api/v1/cameras/cam_b/status')
      .set('Cookie', cookie)
      .expect(200);
    expect((b.body as Body).status?.live).toEqual({});
  });
});
