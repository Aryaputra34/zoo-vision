import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

describe('Swagger modes', () => {
  const apps: INestApplication<App>[] = [];
  const start = async (SWAGGER: string) => {
    const app = await createTestApp({ SWAGGER });
    apps.push(app);
    return app;
  };

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  const docs = (app: INestApplication<App>) =>
    request(app.getHttpServer()).get('/api/docs-json');

  it('SWAGGER=off → GET /api/docs-json 404', async () => {
    await docs(await start('off')).expect(404);
  });

  it('SWAGGER=superadmin → 404 anonymous and for a MANAGER session; 200 for a SUPERADMIN session and a SUPERADMIN token', async () => {
    const app = await start('superadmin');
    await docs(app).expect(404);
    const manager = await asRole(app, 'MANAGER');
    await docs(app).set('Cookie', manager.cookie).expect(404);

    const admin = await asRole(app, 'SUPERADMIN');
    const res = await docs(app).set('Cookie', admin.cookie).expect(200);
    expect(res.body).toMatchObject({ openapi: expect.any(String) as string });

    const created = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Cookie', admin.cookie)
      .send({ name: 'docs', role: 'SUPERADMIN' })
      .expect(201);
    const token = (created.body as { token: string }).token;
    await docs(app).set('Authorization', `Bearer ${token}`).expect(200);
    await docs(app).set('Authorization', 'Bearer zv_wrong').expect(404);

    // the UI page is guarded the same way
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await request(app.getHttpServer())
      .get('/api/docs')
      .set('Cookie', admin.cookie)
      .expect(200);
  });

  it('SWAGGER=public → 200 anonymous', async () => {
    await docs(await start('public')).expect(200);
  });
});
