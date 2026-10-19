import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import { addCamera, addEvent } from './helpers/analytics';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

describe('evidence: keep by hand', () => {
  let app: INestApplication<App>;
  let user: string;
  let manager: string;
  let superadmin: string;
  let infoEvent: string;

  const http = () => request(app.getHttpServer());
  const keep = (id: string, cookie = manager) =>
    http().post(`/api/v1/events/${id}/evidence`).set('Cookie', cookie);
  const rows = () =>
    ownerQuery(
      `SELECT "eventId", "status", "reason", "attempts", "error" FROM "Evidence"`,
    ) as Promise<
      {
        eventId: string;
        status: string;
        reason: string;
        attempts: number;
        error: string | null;
      }[]
    >;

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    user = (await asRole(app, 'USER')).cookie;
    manager = (await asRole(app, 'MANAGER')).cookie;
    superadmin = (await asRole(app, 'SUPERADMIN')).cookie;
    await addCamera('ev_cam');
    infoEvent = await addEvent({
      time: '2026-10-14T03:00:00Z',
      cameraId: 'ev_cam',
      useCase: 'cashier_presence',
      type: 'customer_waiting',
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('POST as a USER → 403; as a MANAGER on an info event → 200 USER QUEUED; again → 200, still one row', async () => {
    await keep(infoEvent, user).expect(403);
    const first = await keep(infoEvent).expect(200);
    expect(first.body).toEqual({
      eventId: infoEvent,
      status: 'QUEUED',
      reason: 'USER',
    });
    await keep(infoEvent).expect(200);
    expect(await rows()).toHaveLength(1);
    const audit = (await ownerQuery(
      `SELECT "entityId" FROM "AuditLog" WHERE "action" = 'evidence.keep'`,
    )) as { entityId: string }[];
    expect(audit[0].entityId).toBe(infoEvent);
  });

  it('a FAILED row → POST → 200 QUEUED, attempts 0, error null', async () => {
    await ownerQuery(
      `UPDATE "Evidence" SET "status" = 'FAILED', "attempts" = 9, "error" = 'recording service unavailable'`,
    );
    const res = await keep(infoEvent).expect(200);
    expect(res.body).toMatchObject({ status: 'QUEUED' });
    expect(await rows()).toMatchObject([
      { status: 'QUEUED', attempts: 0, error: null },
    ]);
  });

  it('keeping an event that has just happened waits until its clip window has ended (event + clipAfterSec + 60 s)', async () => {
    const recent = await addEvent({
      time: new Date(Date.now() - 10_000).toISOString(),
      cameraId: 'ev_cam',
      useCase: 'cashier_presence',
      type: 'customer_waiting',
    });
    await keep(recent).expect(200);
    const [row] = (await ownerQuery(
      `SELECT EXTRACT(EPOCH FROM "runAt" - now()) AS wait FROM "Evidence" WHERE "eventId" = '${recent}'`,
    )) as { wait: string }[];
    // clipAfterSec is 15: 15 + 60 s after the event, 10 s are gone, so about 65 s from now
    expect(Number(row.wait)).toBeGreaterThan(55);
    expect(Number(row.wait)).toBeLessThan(70);
  });

  it('an unknown event → 404 NOT_FOUND; a system event → 404 RECORDING_NOT_AVAILABLE', async () => {
    const unknown = await keep('evt_nope').expect(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
    const system = await addEvent({
      time: '2026-10-14T03:00:00Z',
      cameraId: null,
      useCase: 'system',
      type: 'engine_started',
    });
    const res = await keep(system).expect(404);
    expect(res.body).toMatchObject({ code: 'RECORDING_NOT_AVAILABLE' });
  });

  it('GET /events shows evidence {status, reason} on that row and null on others', async () => {
    const other = await addEvent({
      time: '2026-10-14T03:05:00Z',
      cameraId: 'ev_cam',
      useCase: 'cashier_presence',
      type: 'customer_waiting',
    });
    const res = await http()
      .get('/api/v1/events')
      .set('Cookie', user)
      .query({ from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' })
      .expect(200);
    const byId = new Map(
      (res.body as { rows: { id: string; evidence: unknown }[] }).rows.map(
        (r) => [r.id, r.evidence],
      ),
    );
    expect(byId.get(infoEvent)).toEqual({ status: 'QUEUED', reason: 'USER' });
    expect(byId.get(other)).toBeNull();
  });

  it('PATCH recording.evidenceRetentionDays as a MANAGER → 403; as a SUPERADMIN → saved, audit before/after', async () => {
    // a camera made through the API: addCamera's placeholder URL cannot be decrypted
    await http()
      .post('/api/v1/cameras')
      .set('Cookie', superadmin)
      .send({
        id: 'ev_api_cam',
        name: 'Cam',
        useCase: 'cashier_presence',
        sourceType: 'RTSP',
        mainStreamUrl: 'rtsp://u:p@10.1.2.3/main',
        settings: validSettings('cashier_presence'),
      })
      .expect(201);
    const patch = (cookie: string) =>
      http()
        .patch('/api/v1/cameras/ev_api_cam')
        .set('Cookie', cookie)
        .send({ recording: { evidenceRetentionDays: 30 } });
    await patch(manager).expect(403);
    const res = await patch(superadmin).expect(200);
    expect(res.body).toMatchObject({
      recording: { evidenceRetentionDays: 30 },
    });
    const audit = (await ownerQuery(
      `SELECT "before", "after" FROM "AuditLog" WHERE "action" = 'camera.update'`,
    )) as {
      before: { recording: { evidenceRetentionDays: number | null } };
      after: { recording: { evidenceRetentionDays: number } };
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].before.recording.evidenceRetentionDays).toBeNull();
    expect(audit[0].after.recording.evidenceRetentionDays).toBe(30);
  });
});
