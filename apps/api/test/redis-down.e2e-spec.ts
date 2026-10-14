import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { flushRedis, resetDb } from './setup/db';

describe('Redis down', () => {
  let app: INestApplication<App>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    // Postgres works, but nothing listens on this Redis port
    app = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' });
  });

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/login answers 503 UNAVAILABLE within 7 s', async () => {
    const started = Date.now();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'nobody', password: 'whatever-123' })
      .expect(503);

    expect(Date.now() - started).toBeLessThan(7_000);
    expect(res.body).toEqual({
      statusCode: 503,
      code: 'UNAVAILABLE',
      message: 'Service temporarily unavailable',
    });
  });
});
