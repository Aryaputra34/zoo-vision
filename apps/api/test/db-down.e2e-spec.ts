import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

describe('Postgres down', () => {
  let live: INestApplication<App>;
  let down: INestApplication<App>;

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    live = await createTestApp();
    // same Redis (so the session is valid), but nothing listens on this Postgres port
    down = await createTestApp({
      DATABASE_URL: 'postgresql://zoo_api:x@127.0.0.1:1/zoo',
    });
  });

  afterAll(async () => {
    await down.close();
    await live.close();
  });

  it('API reads answer 503 "Service unavailable", without the driver error text', async () => {
    const { cookie } = await asRole(live, 'SUPERADMIN');

    const res = await request(down.getHttpServer())
      .get('/api/v1/cameras')
      .set('Cookie', cookie)
      .expect(503);

    expect(res.body).toEqual({
      statusCode: 503,
      message: 'Service unavailable',
    });
  });
});
