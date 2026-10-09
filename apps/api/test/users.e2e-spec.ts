import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { asRole, login, seedUser } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

type UserBody = {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
};

describe('users', () => {
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
  const newUser = (over: object = {}) => ({
    username: 'newbie',
    name: 'New Bie',
    password: 'correct-horse-1',
    role: 'USER',
    ...over,
  });

  it('USER gets 403 on GET and POST /users', async () => {
    const { cookie } = await asRole(app, 'USER');
    await http().get('/api/v1/users').set('Cookie', cookie).expect(403);
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser())
      .expect(403);
  });

  it('MANAGER creates USER and MANAGER; 403 for role SUPERADMIN; 403 on PATCH of a superadmin', async () => {
    const { cookie } = await asRole(app, 'MANAGER');
    const u = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser({ username: 'u-one' }))
      .expect(201);
    const body = u.body as UserBody;
    expect(Object.keys(body).sort()).toEqual([
      'active',
      'createdAt',
      'id',
      'name',
      'role',
      'username',
    ]);
    expect(body.role).toBe('USER');
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser({ username: 'm-one', role: 'MANAGER' }))
      .expect(201);
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser({ username: 's-one', role: 'SUPERADMIN' }))
      .expect(403);
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser({ username: 'u-one' }))
      .expect(409);
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send(newUser({ username: 'x', password: 'short' }))
      .expect(400);

    const sa = await seedUser(app, 'SUPERADMIN');
    await http()
      .patch(`/api/v1/users/${sa.id}`)
      .set('Cookie', cookie)
      .send({ name: 'hacked' })
      .expect(403);
    await http()
      .patch(`/api/v1/users/${body.id}`)
      .set('Cookie', cookie)
      .send({ role: 'SUPERADMIN' })
      .expect(403);
    await http()
      .patch(`/api/v1/users/${body.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed', role: 'MANAGER' })
      .expect(200);
  });

  it("MANAGER's list has no superadmins; SUPERADMIN's list has everyone", async () => {
    const mgr = await asRole(app, 'MANAGER');
    const sa = await asRole(app, 'SUPERADMIN');
    await seedUser(app, 'USER');
    const m = await http()
      .get('/api/v1/users')
      .set('Cookie', mgr.cookie)
      .expect(200);
    expect((m.body as UserBody[]).map((u) => u.role).sort()).toEqual([
      'MANAGER',
      'USER',
    ]);
    expect(JSON.stringify(m.body)).not.toMatch(/hash|\$2[aby]\$/i);
    const s = await http()
      .get('/api/v1/users')
      .set('Cookie', sa.cookie)
      .expect(200);
    expect((s.body as UserBody[]).map((u) => u.role).sort()).toEqual([
      'MANAGER',
      'SUPERADMIN',
      'USER',
    ]);
  });

  it('deactivating a logged-in user ends their session on the next request', async () => {
    const mgr = await asRole(app, 'MANAGER');
    const victim = await asRole(app, 'USER');
    await http()
      .get('/api/v1/auth/me')
      .set('Cookie', victim.cookie)
      .expect(200);
    await http()
      .patch(`/api/v1/users/${victim.user.id}`)
      .set('Cookie', mgr.cookie)
      .send({ active: false })
      .expect(200);
    await http()
      .get('/api/v1/auth/me')
      .set('Cookie', victim.cookie)
      .expect(401);
  });

  it('setting a password through PATCH revokes the user sessions', async () => {
    const mgr = await asRole(app, 'MANAGER');
    const victim = await asRole(app, 'USER');
    await http()
      .patch(`/api/v1/users/${victim.user.id}`)
      .set('Cookie', mgr.cookie)
      .send({ password: 'brand-new-pass-1' })
      .expect(200);
    await http()
      .get('/api/v1/auth/me')
      .set('Cookie', victim.cookie)
      .expect(401);
    await login(app, victim.user.username, 'brand-new-pass-1');
  });

  it('the only superadmin cannot deactivate or demote themselves (409); with a second superadmin both work', async () => {
    const sa = await asRole(app, 'SUPERADMIN');
    const url = `/api/v1/users/${sa.user.id}`;
    await http()
      .patch(url)
      .set('Cookie', sa.cookie)
      .send({ active: false })
      .expect(409);
    await http()
      .patch(url)
      .set('Cookie', sa.cookie)
      .send({ role: 'MANAGER' })
      .expect(409);

    // an inactive second superadmin does not count
    await seedUser(app, 'SUPERADMIN', { active: false });
    await http()
      .patch(url)
      .set('Cookie', sa.cookie)
      .send({ role: 'MANAGER' })
      .expect(409);

    const other = await seedUser(app, 'SUPERADMIN');
    await http()
      .patch(`/api/v1/users/${other.id}`)
      .set('Cookie', sa.cookie)
      .send({ active: false })
      .expect(200);
    await http()
      .patch(`/api/v1/users/${other.id}`)
      .set('Cookie', sa.cookie)
      .send({ active: true })
      .expect(200);
    await http()
      .patch(url)
      .set('Cookie', sa.cookie)
      .send({ role: 'MANAGER' })
      .expect(200);
  });

  it('PATCH of an unknown id is 404', async () => {
    const sa = await asRole(app, 'SUPERADMIN');
    await http()
      .patch('/api/v1/users/00000000-0000-4000-8000-000000000000')
      .set('Cookie', sa.cookie)
      .send({ name: 'x' })
      .expect(404);
  });

  it('password change: wrong current → 400; right → 204; old password fails login; other sessions 401; current session still 200', async () => {
    const user = await seedUser(app, 'USER');
    const cookieA = await login(app, user.username, user.password);
    const cookieB = await login(app, user.username, user.password);
    const put = (current: string, next: string) =>
      http()
        .put('/api/v1/auth/password')
        .set('Cookie', cookieA)
        .send({ currentPassword: current, newPassword: next });

    await put('wrong-password-x', 'another-pass-123').expect(400);
    await put(user.password, 'short').expect(400);
    await put(user.password, 'another-pass-123').expect(204);

    await http()
      .post('/api/v1/auth/login')
      .send({ username: user.username, password: user.password })
      .expect(401);
    await http().get('/api/v1/auth/me').set('Cookie', cookieB).expect(401);
    await http().get('/api/v1/auth/me').set('Cookie', cookieA).expect(200);
    await login(app, user.username, 'another-pass-123');
  });
});
