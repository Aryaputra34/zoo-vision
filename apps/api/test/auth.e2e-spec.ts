import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createSuperadmin } from '../src/cli';
import Redis from 'ioredis';
import { REDIS } from '../src/redis/redis.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './app';
import { asRole, login, seedUser } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

type LoginBody = { id: string; username: string; name: string; role: string };

describe('auth', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  // A fresh app per test: the login throttle is in memory, the lockout is in Redis.
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string) => request(app.getHttpServer()).post(path);
  const attempt = (username: string, password: string) =>
    post('/api/v1/auth/login')
      .set('User-Agent', 'jest-agent')
      .send({ username, password });
  const lastLog = () =>
    prisma.loginLog.findFirstOrThrow({ orderBy: { id: 'desc' } });

  it('login sets an httpOnly SameSite=Lax zoo_session cookie and logs SUCCESS with the user id', async () => {
    const user = await seedUser(app, 'MANAGER', { username: 'alice' });
    const res = await attempt(' Alice ', user.password).expect(200);

    expect(res.body as LoginBody).toEqual({
      id: user.id,
      username: 'alice',
      name: 'Test MANAGER',
      role: 'MANAGER',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|\$2[aby]\$/);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^zoo_session=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${7 * 86400}`);
    expect(cookie).not.toContain('Secure'); // test app: COOKIE_SECURE=false

    const log = await lastLog();
    expect(log).toMatchObject({
      result: 'SUCCESS',
      userId: user.id,
      username: ' Alice ',
      userAgent: 'jest-agent',
    });
    expect(log.ip).toBeTruthy();
  });

  it('marks the cookie Secure when COOKIE_SECURE=true', async () => {
    const secure = await createTestApp({ COOKIE_SECURE: 'true' });
    try {
      const user = await seedUser(secure, 'USER');
      const res = await request(secure.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: user.username, password: user.password })
        .expect(200);
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(
        '; Secure',
      );
    } finally {
      await secure.close();
    }
  });

  it('GET /auth/me returns the actor with the cookie and 401 without it', async () => {
    const user = await seedUser(app, 'USER');
    const cookie = await login(app, user.username, user.password);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(me.body).toEqual({
      type: 'user',
      id: user.id,
      name: 'Test USER',
      role: 'USER',
    });
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', 'zoo_session=nonsense')
      .expect(401);
    expect((await lastLog()).result).toBe('SUCCESS');
  });

  it('keeps /api/health public', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('wrong password → 401, WRONG_PASSWORD with userId; unknown user → 401, WRONG_PASSWORD with userId null', async () => {
    const user = await seedUser(app, 'USER');
    const wrong = await attempt(user.username, 'not-the-password').expect(401);
    expect((wrong.body as { message: string }).message).toBe(
      'Invalid username or password',
    );
    expect(await lastLog()).toMatchObject({
      result: 'WRONG_PASSWORD',
      userId: user.id,
    });

    const unknown = await attempt('nobody', 'whatever-123').expect(401);
    expect((unknown.body as { message: string }).message).toBe(
      'Invalid username or password',
    );
    expect(await lastLog()).toMatchObject({
      result: 'WRONG_PASSWORD',
      userId: null,
      username: 'nobody',
    });
  });

  it('disabled user → 403, DISABLED', async () => {
    const user = await seedUser(app, 'USER', { active: false });
    const res = await attempt(user.username, user.password).expect(403);
    expect((res.body as { message: string }).message).toBe('Account disabled');
    expect(await lastLog()).toMatchObject({
      result: 'DISABLED',
      userId: user.id,
    });
  });

  it('five wrong passwords lock the account: the right password then gets 423 and LOCKED', async () => {
    const user = await seedUser(app, 'USER');
    for (let i = 0; i < 5; i++) {
      await attempt(user.username, 'wrong-password').expect(401);
    }
    const res = await attempt(user.username, user.password).expect(423);
    expect((res.body as { message: string }).message).toBe(
      'Account locked. Try again in 15 minutes.',
    );
    expect(await lastLog()).toMatchObject({
      result: 'LOCKED',
      userId: user.id,
    });
  });

  it('the eleventh attempt in a minute from one IP gets 429 and RATE_LIMITED, the twelfth only 429', async () => {
    for (let i = 0; i < 10; i++) {
      await attempt(`ghost-${i}`, 'whatever-123').expect(401);
    }
    await attempt('ghost-10', 'whatever-123').expect(429);
    expect(await lastLog()).toMatchObject({
      result: 'RATE_LIMITED',
      username: 'ghost-10',
      userId: null,
      userAgent: 'jest-agent',
    });
    await attempt('ghost-11', 'whatever-123').expect(429);
    expect(
      await prisma.loginLog.count({ where: { result: 'RATE_LIMITED' } }),
    ).toBe(1);
  });

  it('a login with X-Forwarded-For: 203.0.113.7 writes LoginLog.ip 203.0.113.7', async () => {
    const user = await seedUser(app, 'USER');
    await attempt(user.username, user.password)
      .set('X-Forwarded-For', '203.0.113.7')
      .expect(200);
    expect((await lastLog()).ip).toBe('203.0.113.7');
  });

  it('TRUSTED_PROXY_HOST not the peer: X-Forwarded-For: 203.0.113.7 is ignored and the socket address is logged', async () => {
    const other = await createTestApp({ TRUSTED_PROXY_HOST: '10.255.255.1' });
    try {
      const user = await seedUser(other, 'USER');
      await request(other.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ username: user.username, password: user.password })
        .expect(200);
      const row = await other
        .get(PrismaService)
        .loginLog.findFirstOrThrow({ orderBy: { id: 'desc' } });
      expect(row.ip).not.toBe('203.0.113.7');
      expect(row.ip).toMatch(/127\.0\.0\.1$/);
    } finally {
      await other.close();
    }
  });

  it('GET /auth/check: 204 with a session, 204 with an API token, 401 UNAUTHENTICATED with nothing', async () => {
    const { cookie } = await asRole(app, 'USER');
    await request(app.getHttpServer())
      .get('/api/v1/auth/check')
      .set('Cookie', cookie)
      .expect(204);

    const sa = await asRole(app, 'SUPERADMIN');
    const made = await request(app.getHttpServer())
      .post('/api/v1/api-tokens')
      .set('Cookie', sa.cookie)
      .send({ name: 'check-test', role: 'USER' })
      .expect(201);
    const token = (made.body as { token: string }).token;
    await request(app.getHttpServer())
      .get('/api/v1/auth/check')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/check')
      .expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('PUT /auth/password: the 6th attempt within 15 minutes → 429 RATE_LIMITED, even with the right password', async () => {
    const user = await seedUser(app, 'USER');
    const cookie = await login(app, user.username, user.password);
    const put = (currentPassword: string) =>
      request(app.getHttpServer())
        .put('/api/v1/auth/password')
        .set('Cookie', cookie)
        .send({ currentPassword, newPassword: 'another-pass-123' });
    for (let i = 0; i < 5; i++) await put('wrong-password-x').expect(400);

    const res = await put(user.password).expect(429);

    expect(res.body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    // the refused request never ran: the old password still logs in
    await login(app, user.username, user.password);
  });

  it('PUT /auth/password with a wrong current password → 400 WRONG_PASSWORD', async () => {
    const user = await seedUser(app, 'USER');
    const cookie = await login(app, user.username, user.password);
    const res = await request(app.getHttpServer())
      .put('/api/v1/auth/password')
      .set('Cookie', cookie)
      .send({
        currentPassword: 'wrong-password-123',
        newPassword: 'another-pass-123',
      })
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'WRONG_PASSWORD',
      message: 'Current password is wrong',
    });
  });

  it('an extra body field gives 400 with no LoginLog row and no session', async () => {
    const user = await seedUser(app, 'USER');
    const redis = app.get<Redis>(REDIS);
    await post('/api/v1/auth/login')
      .send({ username: user.username, password: user.password, x: 1 })
      .expect(400);
    expect(await prisma.loginLog.count()).toBe(0);
    expect(await redis.keys('sess:*')).toEqual([]);
  });

  it('credentials in the query string are rejected', async () => {
    const user = await seedUser(app, 'USER');
    const redis = app.get<Redis>(REDIS);
    const res = await post('/api/v1/auth/login')
      .query({ username: user.username, password: user.password })
      .send({});
    expect([400, 401]).toContain(res.status);
    expect(await prisma.loginLog.count()).toBe(0);
    expect(await redis.keys('sess:*')).toEqual([]);
  });

  it('a 201-character username gives 400 and no loginfail key', async () => {
    const redis = app.get<Redis>(REDIS);
    await attempt('a'.repeat(201), 'whatever-123').expect(400);
    expect(await prisma.loginLog.count()).toBe(0);
    expect(await redis.keys('loginfail:*')).toEqual([]);
  });

  it('8 concurrent wrong passwords leave at most 5 WRONG_PASSWORD rows and the rest LOCKED', async () => {
    const user = await seedUser(app, 'USER');
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        attempt(user.username, 'wrong-password').then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 423)).toHaveLength(3);
    expect(
      await prisma.loginLog.count({ where: { result: 'WRONG_PASSWORD' } }),
    ).toBe(5);
    expect(await prisma.loginLog.count({ where: { result: 'LOCKED' } })).toBe(
      3,
    );
  });

  it('logout → 204, LOGOUT row, and the old cookie gets 401', async () => {
    const user = await seedUser(app, 'USER');
    const cookie = await login(app, user.username, user.password);

    const res = await post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /^zoo_session=;/,
    );
    expect(await lastLog()).toMatchObject({
      result: 'LOGOUT',
      userId: user.id,
      username: user.username,
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('deactivating a logged-in user (UPDATE through Prisma) makes their next request 401', async () => {
    const user = await seedUser(app, 'MANAGER');
    const cookie = await login(app, user.username, user.password);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { active: false },
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(401);
    expect((await lastLog()).result).toBe('SUCCESS');
  });

  it('create-superadmin CLI creates a SUPERADMIN who can log in', async () => {
    const id = await createSuperadmin(prisma, {
      username: 'Root',
      name: 'Root Admin',
      password: 'a-long-password',
    });
    const res = await attempt('root', 'a-long-password').expect(200);
    expect(res.body).toEqual({
      id,
      username: 'root',
      name: 'Root Admin',
      role: 'SUPERADMIN',
    });
    expect((await lastLog()).result).toBe('SUCCESS');

    await expect(
      createSuperadmin(prisma, {
        username: 'root',
        name: 'Again',
        password: 'a-long-password',
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      createSuperadmin(prisma, {
        username: 'short',
        name: 'Short',
        password: 'tooshort',
      }),
    ).rejects.toThrow(/at least 10/);
  });
});
