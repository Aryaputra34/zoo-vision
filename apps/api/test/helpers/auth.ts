import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashPassword } from '../../src/auth/password';
import { SessionService } from '../../src/auth/session.service';
import { Role } from '../../src/generated/prisma/enums';
import { PrismaService } from '../../src/prisma/prisma.service';

type TestApp = INestApplication<App>;
export type SeededUser = { id: string; username: string; password: string };

/** Inserts a user (as zoo_api, like the app). Defaults: random username and password, active. */
export async function seedUser(
  app: TestApp,
  role: Role,
  opts: { username?: string; password?: string; active?: boolean } = {},
): Promise<SeededUser> {
  const username =
    opts.username ?? `${role.toLowerCase()}-${randomBytes(4).toString('hex')}`;
  const password = opts.password ?? `pw-${randomBytes(8).toString('hex')}`;
  const user = await app.get(PrismaService).user.create({
    data: {
      username,
      name: `Test ${role}`,
      passwordHash: await hashPassword(password),
      role,
      active: opts.active ?? true,
    },
  });
  return { id: user.id, username, password };
}

/**
 * Logs in through POST /auth/login and returns the `Cookie` header value. For tests where the
 * login itself is under test; the endpoint is throttled to 10/min per IP, so other suites use
 * {@link asRole}.
 */
export async function login(
  app: TestApp,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('zoo_session='));
  if (!session) throw new Error('login set no zoo_session cookie');
  return session.split(';')[0];
}

/** Seeds a user and mints a session directly (no login request, so no throttle). */
export async function asRole(
  app: TestApp,
  role: Role,
): Promise<{ cookie: string; user: SeededUser }> {
  const user = await seedUser(app, role);
  const token = await app.get(SessionService).create(user.id, {});
  return { cookie: `zoo_session=${token}`, user };
}
