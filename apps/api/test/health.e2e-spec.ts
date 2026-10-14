import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';

type HealthBody = { status: string; info: Record<string, unknown> };
type OpenApiDoc = { components: { securitySchemes: Record<string, unknown> } };

describe('health, env and Swagger', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health reports database and redis up', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('ok');
    expect(Object.keys(body.info)).toEqual(
      expect.arrayContaining(['database', 'redis']),
    );
  });

  it('Redis unreachable → 503 and the body is {"redis": {"status": "down"}, ...} with no "message" key', async () => {
    const noRedis = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const res = await request(noRedis.getHttpServer())
        .get('/api/health')
        .expect(503);
      const body = res.body as {
        error: Record<string, unknown>;
        details: Record<string, unknown>;
      };
      expect(body.error.redis).toEqual({ status: 'down' });
      expect(body.details.redis).toEqual({ status: 'down' });
      expect(res.body).toMatchObject({ statusCode: 503, code: 'UNAVAILABLE' });
    } finally {
      await noRedis.close();
    }
  });

  it('refuses to start without a 32-byte CAMERA_URL_KEY', async () => {
    await expect(
      createTestApp({ CAMERA_URL_KEY: Buffer.alloc(16).toString('base64') }),
    ).rejects.toThrow(/CAMERA_URL_KEY/);
  });

  it('serves the OpenAPI document only when SWAGGER=public', async () => {
    const pub = await createTestApp({ SWAGGER: 'public' });
    try {
      const res = await request(pub.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const doc = res.body as OpenApiDoc;
      expect(Object.keys(doc.components.securitySchemes)).toEqual(
        expect.arrayContaining(['zoo_session', 'bearer']),
      );
    } finally {
      await pub.close();
    }
    // app was built with SWAGGER=off
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });
});
