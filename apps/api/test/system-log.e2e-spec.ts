import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, type Socket } from 'socket.io-client';
import { ContractsService } from '../src/contracts/contracts.service';
import { ModelsService } from '../src/models/models.service';
import { createTestApp, listenTestApp } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Json = Record<string, unknown>;
type AuditRow = {
  id: string;
  time: string;
  actorType: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  auditCamera: boolean;
};
type Page<T> = { rows: T[]; nextCursor: string | null };

const RANGE = {
  from: '2020-01-01T00:00:00Z',
  to: '2099-01-01T00:00:00Z',
};
const MOVED = [
  [0.3, 0.4],
  [0.7, 0.4],
  [0.7, 0.9],
  [0.3, 0.9],
];

describe('system log, audit cameras and model_validation_failed', () => {
  let app: INestApplication<App>;
  let base: string;
  let superadmin: string;
  let manager: string;
  let user: string;
  let managerName: string;
  let sockets: Socket[] = [];
  const settings = validSettings('cashier_presence');

  const http = () => request(app.getHttpServer());
  const get = (path: string, cookie: string, query: Json = {}) =>
    http().get(`/api/v1/system-log/${path}`).set('Cookie', cookie).query(query);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const connect = (cookie: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(base, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { Cookie: cookie },
      });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  const notices = (socket: Socket) => {
    const list: Json[] = [];
    socket.on('audit.notice', (n: Json) => list.push(n));
    return list;
  };
  const createCamera = (id: string, auditCamera: boolean) =>
    http()
      .post('/api/v1/cameras')
      .set('Cookie', superadmin)
      .send({
        id,
        name: id,
        useCase: 'cashier_presence',
        sourceType: 'RTSP',
        mainStreamUrl: 'rtsp://10.1.2.3/main',
        auditCamera,
        settings,
      })
      .expect(201);
  const saveConfig = (id: string, baseVersion: number, cookie = manager) =>
    http()
      .post(`/api/v1/cameras/${id}/config`)
      .set('Cookie', cookie)
      .send({ baseVersion, settings: { ...settings, clerk_zone: MOVED } });
  const auditFlags = async (action: string, entityId: string) =>
    (
      (await ownerQuery(
        `SELECT "auditCamera" FROM "AuditLog" WHERE "action" = $1 AND "entityId" = $2 ORDER BY "id"`,
        action,
        entityId,
      )) as { auditCamera: boolean }[]
    ).map((r) => r.auditCamera);

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    base = await listenTestApp(app);
    superadmin = (await asRole(app, 'SUPERADMIN')).cookie;
    const m = await asRole(app, 'MANAGER');
    manager = m.cookie;
    managerName = 'Test MANAGER';
    user = (await asRole(app, 'USER')).cookie;
    await createCamera('cam_audit', true);
    await createCamera('cam_plain', false);
  });

  afterEach(() => {
    for (const s of sockets) s.close();
    sockets = [];
  });

  afterAll(async () => {
    await app.close();
  });

  it('USER → 403 on every system-log route; MANAGER → 200', async () => {
    const jsonRoutes = ['audit', 'logins', 'system-events'];
    const csvRoutes = ['audit.csv', 'logins.csv', 'system-events.csv'];
    for (const route of [...jsonRoutes, ...csvRoutes]) {
      const denied = await get(route, user, RANGE).expect(403);
      expect([route, (denied.body as { code: string }).code]).toEqual([
        route,
        'FORBIDDEN',
      ]);
      await get(route, manager, RANGE).expect(200);
    }
    for (const route of jsonRoutes) {
      await http().get(`/api/v1/system-log/${route}`).query(RANGE).expect(401);
    }
    const csv = await get('audit.csv', manager, RANGE).expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
  });

  it('a config save on an auditCamera camera writes auditCamera true and sends audit.notice to a MANAGER socket, never to a USER socket', async () => {
    const managerSocket = await connect(manager);
    const userSocket = await connect(user);
    const forManager = notices(managerSocket);
    const forUser = notices(userSocket);

    await saveConfig('cam_audit', 1).expect(201);
    await saveConfig('cam_plain', 1).expect(201);
    await wait(600);

    expect(await auditFlags('camera_config.save', 'cam_audit')).toEqual([true]);
    expect(await auditFlags('camera_config.save', 'cam_plain')).toEqual([
      false,
    ]);

    expect(forManager).toHaveLength(1);
    const [notice] = forManager;
    expect(notice).toEqual({
      auditId: expect.stringMatching(/^\d+$/) as string,
      cameraId: 'cam_audit',
      actorName: managerName,
      action: 'camera_config.save',
      time: expect.any(String) as string,
    });
    expect(new Date(notice.time as string).toISOString()).toBe(notice.time);
    expect(
      app
        .get(ContractsService)
        .validator.validateWsMessage('audit.notice', notice),
    ).toEqual({ ok: true });
    expect(forUser).toEqual([]);

    // the notice names the audit row
    const row = (await ownerQuery(
      `SELECT "action", "entityId" FROM "AuditLog" WHERE "id" = $1`,
      notice.auditId,
    )) as { action: string; entityId: string }[];
    expect(row).toEqual([
      { action: 'camera_config.save', entityId: 'cam_audit' },
    ]);
  });

  it('a camera field change, a rollback and switching the flag off are flagged; the next change is not', async () => {
    const managerSocket = await connect(manager);
    const seen = notices(managerSocket);
    await createCamera('cam_flip', true);

    await http()
      .patch('/api/v1/cameras/cam_flip')
      .set('Cookie', manager)
      .send({ name: 'Renamed' })
      .expect(200);
    await saveConfig('cam_flip', 1).expect(201);
    await http()
      .post('/api/v1/cameras/cam_flip/config/rollback')
      .set('Cookie', manager)
      .send({ baseVersion: 2, version: 1 })
      .expect(201);
    // switching the flag off: the row is about an audit camera (before), so it is flagged
    await http()
      .patch('/api/v1/cameras/cam_flip')
      .set('Cookie', superadmin)
      .send({ auditCamera: false })
      .expect(200);
    await http()
      .patch('/api/v1/cameras/cam_flip')
      .set('Cookie', manager)
      .send({ name: 'Again' })
      .expect(200);
    await wait(600);

    expect(await auditFlags('camera.update', 'cam_flip')).toEqual([
      true,
      true,
      false,
    ]);
    expect(await auditFlags('camera_config.save', 'cam_flip')).toEqual([true]);
    expect(await auditFlags('camera_config.rollback', 'cam_flip')).toEqual([
      true,
    ]);
    expect(seen.map((n) => n.action)).toEqual([
      'camera.update',
      'camera_config.save',
      'camera_config.rollback',
      'camera.update',
    ]);
  });

  it('auditCamera=true filters; paging by id stays stable', async () => {
    const all = (
      await get('audit', manager, { ...RANGE, limit: 500 }).expect(200)
    ).body as Page<AuditRow>;
    const flagged = (
      await get('audit', manager, {
        ...RANGE,
        auditCamera: 'true',
        limit: 500,
      }).expect(200)
    ).body as Page<AuditRow>;
    expect(flagged.rows.length).toBeGreaterThanOrEqual(3);
    expect(flagged.rows.every((r) => r.auditCamera)).toBe(true);
    expect(all.rows.some((r) => !r.auditCamera)).toBe(true);
    const unflagged = (
      await get('audit', manager, {
        ...RANGE,
        auditCamera: 'false',
        limit: 500,
      }).expect(200)
    ).body as Page<AuditRow>;
    expect(unflagged.rows.every((r) => !r.auditCamera)).toBe(true);

    // newest first, ids as strings, and the row carries what the audit interceptor stored
    const ids = flagged.rows.map((r) => BigInt(r.id));
    expect([...ids].sort((a, b) => (a < b ? 1 : -1))).toEqual(ids);
    expect(flagged.rows[0]).toMatchObject({
      actorType: 'user',
      entity: 'camera',
      auditCamera: true,
    });

    // two per page, with a new flagged row arriving between the pages
    const first = (
      await get('audit', manager, {
        ...RANGE,
        auditCamera: 'true',
        limit: 2,
      }).expect(200)
    ).body as Page<AuditRow>;
    expect(first.rows.map((r) => r.id)).toEqual(
      flagged.rows.slice(0, 2).map((r) => r.id),
    );
    await http()
      .patch('/api/v1/cameras/cam_audit')
      .set('Cookie', manager)
      .send({ area: 'North' })
      .expect(200);
    const second = (
      await get('audit', manager, {
        ...RANGE,
        auditCamera: 'true',
        limit: 2,
        cursor: first.nextCursor as string,
      }).expect(200)
    ).body as Page<AuditRow>;
    expect(second.rows.map((r) => r.id)).toEqual(
      flagged.rows.slice(2, 4).map((r) => r.id),
    );
  });

  it('audit filters: entity, action and actor; a bad cursor or limit is VALIDATION_FAILED', async () => {
    const byEntity = (
      await get('audit', manager, {
        ...RANGE,
        entity: 'camera',
        action: 'camera.update',
      }).expect(200)
    ).body as Page<AuditRow>;
    expect(byEntity.rows.length).toBeGreaterThan(0);
    expect(
      byEntity.rows.every(
        (r) => r.entity === 'camera' && r.action === 'camera.update',
      ),
    ).toBe(true);
    const byActor = (
      await get('audit', manager, { ...RANGE, actor: 'test manager' }).expect(
        200,
      )
    ).body as Page<AuditRow>;
    expect(byActor.rows.every((r) => r.actorName === managerName)).toBe(true);

    for (const query of [{ cursor: 'x' }, { limit: 501 }, { limit: 0 }]) {
      const res = await get('audit', manager, { ...RANGE, ...query }).expect(
        400,
      );
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });

  it('logins lists WRONG_PASSWORD and SUCCESS rows for a username', async () => {
    const username = `login-${Date.now().toString(36)}`;
    const created = await http()
      .post('/api/v1/users')
      .set('Cookie', superadmin)
      .send({
        username,
        name: 'Login Probe',
        password: 'correct-horse-battery',
        role: 'USER',
      })
      .expect(201);
    expect((created.body as { id: string }).id).toBeDefined();

    await http()
      .post('/api/v1/auth/login')
      .send({ username, password: 'wrong-password-123' })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ username, password: 'correct-horse-battery' })
      .expect(200);

    const res = await get('logins', manager, { ...RANGE, username }).expect(
      200,
    );
    const rows = (res.body as Page<Json>).rows;
    expect(rows.map((r) => r.result)).toEqual(['SUCCESS', 'WRONG_PASSWORD']);
    expect(rows[0]).toMatchObject({
      username,
      userId: (created.body as { id: string }).id,
      id: expect.stringMatching(/^\d+$/) as string,
    });
    expect(typeof rows[0].ip).toBe('string');

    const wrongOnly = (
      await get('logins', manager, {
        ...RANGE,
        username,
        result: 'WRONG_PASSWORD',
      }).expect(200)
    ).body as Page<Json>;
    expect(wrongOnly.rows.map((r) => r.result)).toEqual(['WRONG_PASSWORD']);
    await get('logins', manager, { ...RANGE, result: 'NOPE' }).expect(400);
  });

  it('a FAILED validation report adds one model_validation_failed system event; a READY one adds none', async () => {
    const insert = async (name: string) => {
      const [{ id }] = (await ownerQuery(
        `INSERT INTO "AiModel" ("id", "name", "format", "source", "status", "filePath", "originalName", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'ONNX', 'UPLOAD', 'VALIDATING', $2, $1 || '.onnx', now())
         RETURNING "id"`,
        name,
        `registry/${name}.onnx`,
      )) as { id: string }[];
      return id;
    };
    const events = async () =>
      (await ownerQuery(
        `SELECT "id", "time", "cameraId", "useCase", "type", "severity", "configVersion", "schemaVersion", "data"
           FROM "Event" WHERE "type" = 'model_validation_failed' ORDER BY "time"`,
      )) as Json[];
    const models = app.get(ModelsService);

    const good = await insert('good-model');
    await models.reportValidation(good, {
      ok: true,
      classNames: ['a'],
      latencyMs: 12,
      device: 'cpu',
    });
    expect(await events()).toEqual([]);

    const bad = await insert('bad-model');
    await models.reportValidation(bad, {
      ok: false,
      error: 'unsupported opset 99',
    });

    const found = await events();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: expect.stringMatching(/^evt_[0-9a-f]{32}$/) as string,
      cameraId: null,
      useCase: 'system',
      type: 'model_validation_failed',
      severity: 'warning',
      configVersion: null,
      data: { modelId: bad, name: 'bad-model', error: 'unsupported opset 99' },
    });
    // it is a contract-valid system event
    const { validator, registry } = app.get(ContractsService);
    expect(
      validator.validateMessage({
        message: 'event',
        id: found[0].id,
        cameraId: null,
        useCase: 'system',
        type: 'model_validation_failed',
        severity: 'warning',
        schemaVersion: registry.useCases.get('system')?.schemaVersion,
        configVersion: null,
        time: new Date(found[0].time as string).toISOString(),
        snapshotPath: null,
        data: found[0].data,
      }),
    ).toEqual({ ok: true });

    // and the System events page sees it, as an event row
    const res = await get('system-events', manager, RANGE).expect(200);
    const rows = (res.body as Page<Json>).rows;
    expect(rows.map((r) => r.type)).toContain('model_validation_failed');
    expect(rows.every((r) => r.useCase === 'system')).toBe(true);
  });

  it('system-events.csv contains the system events, and the export is audited', async () => {
    const res = await get('system-events.csv', manager, RANGE)
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => done(null, text));
      })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('model_validation_failed');
    expect(text.split('\r\n')[0]).toContain('data.modelId');

    const rows = (await ownerQuery(
      `SELECT "after" FROM "AuditLog" WHERE "action" = 'export.csv' ORDER BY "id" DESC LIMIT 1`,
    )) as { after: { kind: string } }[];
    expect(rows[0].after.kind).toBe('system-events');

    for (const route of ['audit.csv', 'logins.csv']) {
      const csv = await get(route, manager, RANGE).expect(200);
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    }
  });
});
