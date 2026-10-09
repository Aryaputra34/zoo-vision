import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type TokenBody = {
  id: string;
  name: string;
  role: string;
  prefix: string;
  createdAt: string;
  token: string;
};

describe('api tokens', () => {
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

  async function mint(role: string, name = 'ci'): Promise<TokenBody> {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    const res = await http()
      .post('/api/v1/api-tokens')
      .set('Cookie', cookie)
      .send({ name, role })
      .expect(201);
    return res.body as TokenBody;
  }

  it('a created token authenticates GET /auth/me as {type: token, role}', async () => {
    const t = await mint('MANAGER');
    expect(t.token).toMatch(/^zv_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.token.slice(3, 11));
    expect(Object.keys(t).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'prefix',
      'role',
      'token',
    ]);
    const me = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${t.token}`)
      .expect(200);
    expect(me.body).toEqual({
      type: 'token',
      id: t.id,
      name: 'ci',
      role: 'MANAGER',
    });
  });

  it('a USER-role token gets 403 on POST /users', async () => {
    const t = await mint('USER');
    await http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${t.token}`)
      .send({
        username: 'newbie',
        name: 'N',
        password: 'correct-horse-1',
        role: 'USER',
      })
      .expect(403);
  });

  it('a revoked token gets 401 on its next request', async () => {
    const t = await mint('MANAGER');
    const auth = { Authorization: `Bearer ${t.token}` };
    await http().get('/api/v1/auth/me').set(auth).expect(200);
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await http()
      .delete(`/api/v1/api-tokens/${t.id}`)
      .set('Cookie', cookie)
      .expect(204);
    await http()
      .delete(`/api/v1/api-tokens/${t.id}`)
      .set('Cookie', cookie)
      .expect(204);
    await http().get('/api/v1/auth/me').set(auth).expect(401);
  });

  it('the list and every audit row never contain the raw token or its hash', async () => {
    const t = await mint('MANAGER');
    const hash = createHash('sha256').update(t.token).digest('hex');
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await http()
      .delete(`/api/v1/api-tokens/${t.id}`)
      .set('Cookie', cookie)
      .expect(204);
    const list = await http()
      .get('/api/v1/api-tokens')
      .set('Cookie', cookie)
      .expect(200);
    const rows = await ownerQuery('SELECT * FROM "AuditLog"');
    const listed = list.body as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual([
      'createdAt',
      'createdBy',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'revokedAt',
      'role',
    ]);
    expect(listed[0].revokedAt).not.toBeNull();
    const actions = (rows as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['api_token.create', 'api_token.revoke']),
    );
    for (const dump of [JSON.stringify(list.body), JSON.stringify(rows)]) {
      expect(dump).not.toContain(t.token);
      expect(dump).not.toContain(hash);
    }
  });

  it('MANAGER gets 403 on all three endpoints', async () => {
    const { cookie } = await asRole(app, 'MANAGER');
    await http()
      .post('/api/v1/api-tokens')
      .set('Cookie', cookie)
      .send({ name: 'x', role: 'USER' })
      .expect(403);
    await http().get('/api/v1/api-tokens').set('Cookie', cookie).expect(403);
    await http()
      .delete('/api/v1/api-tokens/00000000-0000-4000-8000-000000000000')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('"Bearer abc" gets 401 even with a valid session cookie', async () => {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    for (const header of ['Bearer abc', 'Bearer zv_unknown', 'Basic zv_x']) {
      await http()
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Authorization', header)
        .expect(401);
    }
  });

  it('lastUsedAt is set after the token is used', async () => {
    const t = await mint('USER');
    const { cookie } = await asRole(app, 'SUPERADMIN');
    const before = await http()
      .get('/api/v1/api-tokens')
      .set('Cookie', cookie)
      .expect(200);
    expect((before.body as { lastUsedAt: string | null }[])[0].lastUsedAt).toBe(
      null,
    );
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${t.token}`)
      .expect(200);
    const after = await http()
      .get('/api/v1/api-tokens')
      .set('Cookie', cookie)
      .expect(200);
    expect(
      (after.body as { lastUsedAt: string | null }[])[0].lastUsedAt,
    ).toEqual(expect.any(String));
  });

  it('PUT /auth/password with a token gets 403', async () => {
    const t = await mint('SUPERADMIN');
    await http()
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${t.token}`)
      .send({ currentPassword: 'whatever-1234', newPassword: 'another-1234' })
      .expect(403);
  });

  it('POST /auth/logout with a token is a 204 no-op', async () => {
    const t = await mint('USER');
    const res = await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${t.token}`)
      .expect(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await ownerQuery('SELECT 1 FROM "LoginLog"')).toHaveLength(0);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${t.token}`)
      .expect(200);
  });

  it('rejects invalid bodies', async () => {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    for (const body of [
      { name: '', role: 'USER' },
      { name: 'x'.repeat(101), role: 'USER' },
      { name: 'x', role: 'ROOT' },
    ]) {
      await http()
        .post('/api/v1/api-tokens')
        .set('Cookie', cookie)
        .send(body)
        .expect(400);
    }
  });
});
