import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { addCamera, addEvent } from './helpers/analytics';
import { asRole } from './helpers/auth';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

describe('/api/v1/site-settings', () => {
  let app: INestApplication<App>;
  let user: string;
  let manager: string;
  let superadmin: string;

  const http = () => request(app.getHttpServer());
  const patch = (body: object, cookie = superadmin) =>
    http().patch('/api/v1/site-settings').set('Cookie', cookie).send(body);

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    user = (await asRole(app, 'USER')).cookie;
    manager = (await asRole(app, 'MANAGER')).cookie;
    superadmin = (await asRole(app, 'SUPERADMIN')).cookie;
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET as a USER → the six defaults', async () => {
    const res = await http()
      .get('/api/v1/site-settings')
      .set('Cookie', user)
      .expect(200);
    expect(res.body).toEqual({
      siteName: 'Zoo Vision',
      timeZone: 'Asia/Jakarta',
      recordingRetentionDays: 7,
      snapshotRetentionDays: 90,
      auditSnapshotRetentionDays: 365,
      evidenceRetentionDays: 365,
    });
  });

  it('PATCH as a MANAGER → 403; bad zone → 400 at /timeZone; 0 days → 400', async () => {
    await patch({ siteName: 'X' }, manager).expect(403);
    const zone = await patch({ timeZone: 'Mars/Base' }).expect(400);
    expect(zone.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/timeZone' }],
    });
    const days = await patch({ snapshotRetentionDays: 0 }).expect(400);
    expect(days.body).toMatchObject({
      errors: [{ path: '/snapshotRetentionDays' }],
    });
  });

  it('PATCH {timeZone: "Asia/Makassar"} → the next events.csv writes local times one hour later, without a new app', async () => {
    await addCamera('tz_cam');
    await addEvent({
      time: '2026-10-14T03:00:00Z',
      cameraId: 'tz_cam',
      useCase: 'cashier_presence',
      type: 'customer_waiting',
    });
    const firstRow = async () => {
      const res = await http()
        .get('/api/v1/exports/events.csv')
        .set('Cookie', user)
        .query({
          from: '2026-10-14T00:00:00Z',
          to: '2026-10-15T00:00:00Z',
        })
        .buffer(true)
        .parse((r, done) => {
          let text = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => (text += c));
          r.on('end', () => done(null, text));
        });
      return (res.body as string).split('\r\n')[1].split(',')[0];
    };
    try {
      expect(await firstRow()).toBe('2026-10-14 10:00:00');
      await patch({ timeZone: 'Asia/Makassar' }).expect(200);
      expect(await firstRow()).toBe('2026-10-14 11:00:00');
    } finally {
      await patch({ timeZone: 'Asia/Jakarta' }).expect(200);
    }
  });

  it('PATCH writes one audit row site_settings.update with before/after of the changed field', async () => {
    await ownerQuery(
      `DELETE FROM "AuditLog" WHERE "action" = 'site_settings.update'`,
    );
    await patch({ snapshotRetentionDays: 30, siteName: 'Zoo Vision' }).expect(
      200,
    );
    const rows = (await ownerQuery(
      `SELECT "entity", "before", "after" FROM "AuditLog" WHERE "action" = 'site_settings.update'`,
    )) as { entity: string; before: object; after: object }[];
    expect(rows).toEqual([
      {
        entity: 'site_settings',
        before: { snapshotRetentionDays: 90 },
        after: { snapshotRetentionDays: 30 },
      },
    ]);
  });
});
