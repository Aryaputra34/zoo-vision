import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './app';
import { asRole, login, seedUser } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

const dump = (row: object) =>
  JSON.stringify(row, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

describe('audit log', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('creating a user writes user.create with after = UserDto and no secrets', async () => {
    const { cookie, user: mgr } = await asRole(app, 'MANAGER');
    const password = 'plain-secret-pass-9';
    const res = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send({ username: 'auditee', name: 'Audi Tee', password, role: 'USER' })
      .expect(201);
    const dto = res.body as { id: string };

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      action: 'user.create',
      entity: 'user',
      entityId: dto.id,
      actorType: 'user',
      actorId: mgr.id,
      actorName: 'Test MANAGER',
    });
    expect(row.ip).toBeTruthy();
    expect(row.after).toEqual(res.body);
    const text = dump(row);
    expect(text).not.toMatch(/passwordHash/);
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).not.toContain(password);
  });

  it('PATCH and password change are audited without secrets', async () => {
    const { cookie } = await asRole(app, 'SUPERADMIN');
    const target = await seedUser(app, 'USER');
    await http()
      .patch(`/api/v1/users/${target.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed', password: 'patched-pass-123' })
      .expect(200);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.update' },
    });
    expect(row.entityId).toBe(target.id);
    expect(row.before).toMatchObject({ name: 'Test USER' });
    expect(row.after).toMatchObject({ name: 'Renamed', passwordChanged: true });
    expect(dump(row)).not.toMatch(/passwordHash|\$2[aby]\$|patched-pass-123/);

    const me = await asRole(app, 'USER');
    await http()
      .put('/api/v1/auth/password')
      .set('Cookie', me.cookie)
      .send({
        currentPassword: me.user.password,
        newPassword: 'changed-pass-1234',
      })
      .expect(204);
    const pw = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.password' },
    });
    expect(pw).toMatchObject({ entity: 'user', entityId: me.user.id });
    expect(dump(pw)).not.toMatch(
      new RegExp(`${me.user.password}|changed-pass-1234|\\$2[aby]\\$`),
    );
  });

  it('a 403 POST /users by a USER writes no audit row', async () => {
    const { cookie } = await asRole(app, 'USER');
    await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send({
        username: 'nope',
        name: 'No',
        password: 'long-enough-pw',
        role: 'USER',
      })
      .expect(403);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('login and logout write no audit row', async () => {
    const user = await seedUser(app, 'USER');
    const cookie = await login(app, user.username, user.password);
    await http().post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
