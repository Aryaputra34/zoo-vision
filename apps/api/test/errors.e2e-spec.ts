import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole, seedUser } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, resetDb } from './setup/db';

type ErrorBody = {
  statusCode: number;
  code: string;
  message: string;
  errors?: { path: string; message: string }[];
};

describe('error shape', () => {
  let app: INestApplication<App>;
  let manager: string;
  let superadmin: string;
  const settings = validSettings('cashier_presence');

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
  const save = (cookie: string, payload: object) =>
    http()
      .post('/api/v1/cameras/cam_test_01/config')
      .set('Cookie', cookie)
      .send(payload);

  it('an unknown route → 404 {statusCode: 404, code: "NOT_FOUND", message}', async () => {
    const res = await http().get('/api/v1/nope').expect(404);
    const body = res.body as ErrorBody;
    expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(typeof body.message).toBe('string');
  });

  it('POST /users with a 5000-character name → 400 VALIDATION_FAILED, errors[0].path "/name"', async () => {
    const res = await http()
      .post('/api/v1/users')
      .set('Cookie', manager)
      .send({
        username: 'bob',
        name: 'x'.repeat(5000),
        role: 'USER',
        password: 'correct-horse-battery-staple',
      })
      .expect(400);
    const body = res.body as ErrorBody;
    expect(body).toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
    expect(body.errors?.[0].path).toBe('/name');
  });

  it('saving settings with a 2-point polygon → 400 SETTINGS_INVALID, errors[0].path names the polygon', async () => {
    const res = await save(manager, {
      baseVersion: 1,
      settings: {
        ...settings,
        clerk_zone: [
          [0.1, 0.1],
          [0.2, 0.2],
        ],
      },
    }).expect(400);
    const body = res.body as ErrorBody;
    expect(body).toMatchObject({ statusCode: 400, code: 'SETTINGS_INVALID' });
    expect(body.errors?.[0].path).toContain('/clerk_zone');
  });

  it('a MANAGER changing model_id → 403 ROLE_REQUIRED, errors contains {path: "/model_id"}', async () => {
    const res = await save(manager, {
      baseVersion: 1,
      settings: {
        ...settings,
        model_id: '5f0e2a4c-1d3b-4c6e-8a7f-9b0c1d2e3f40',
      },
    }).expect(403);
    const body = res.body as ErrorBody;
    expect(body).toMatchObject({ statusCode: 403, code: 'ROLE_REQUIRED' });
    expect(body.errors).toContainEqual({
      path: '/model_id',
      message: 'needs SUPERADMIN',
    });
    expect(body).not.toHaveProperty('fields');
  });

  it('a stale baseVersion → 409 STALE_VERSION', async () => {
    const res = await save(manager, { baseVersion: 99, settings }).expect(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: 'STALE_VERSION' });
  });

  it('the 11th login within a minute → 429 RATE_LIMITED', async () => {
    const user = await seedUser(app, 'USER');
    const attempt = () =>
      http()
        .post('/api/v1/auth/login')
        .send({ username: user.username, password: 'wrong-password-123' });
    for (let i = 0; i < 10; i++) await attempt();
    const res = await attempt().expect(429);
    expect(res.body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });

  it('no session → 401 UNAUTHENTICATED', async () => {
    const res = await http().get('/api/v1/auth/me').expect(401);
    expect(res.body).toMatchObject({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  });
});
