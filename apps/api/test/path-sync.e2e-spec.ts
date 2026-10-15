import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PathSync } from '../src/mediamtx/path-sync.service';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, resetDb } from './setup/db';

const PASSWORD = 'mtx-test-pw-0123456789';
const BASIC = `Basic ${Buffer.from(`zoo:${PASSWORD}`).toString('base64')}`;
const URL_MAIN = 'rtsp://admin:p%40ss%3Aw@10.1.2.3:554/main';
const URL_SUB = 'rtsp://admin:p%40ss%3Aw@10.1.2.3:554/sub';

type Call = { method: string; path: string; auth: string | undefined };

/**
 * A MediaMTX Control API that keeps paths in memory and records every call. Like the real one
 * (1.21.1) it hands durations back as Go prints them: "3d" becomes "72h0m0s".
 */
function fakeMediamtx() {
  const paths = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  const state = { failing: false };
  const goDuration = (v: unknown) => {
    const m = /^(\d+)d$/.exec(String(v));
    return m ? `${Number(m[1]) * 24}h0m0s` : v;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mtx');
    calls.push({
      method: req.method ?? '',
      path: url.pathname,
      auth: req.headers.authorization,
    });
    const send = (status: number, body: unknown = { status: 'ok' }) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== BASIC) return send(401);
      const [, , , , action, name] = url.pathname.split('/');
      if (url.pathname === '/v3/config/paths/list') {
        const items = [...paths].map(([n, conf]) => ({ name: n, ...conf }));
        return send(200, { itemCount: items.length, pageCount: 1, items });
      }
      if (req.method === 'GET') return send(404);
      if (state.failing) return send(503, { error: 'busy' });
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >)
        : {};
      if (body.recordDeleteAfter) {
        body.recordDeleteAfter = goDuration(body.recordDeleteAfter);
      }
      if (action === 'add') paths.set(name, body);
      else if (action === 'patch' && paths.has(name)) {
        paths.set(name, { ...paths.get(name), ...body });
      } else if (action === 'delete' && paths.delete(name)) {
        // done
      } else return send(404, { error: 'path not found' });
      send(200);
    });
  });
  return {
    paths,
    calls,
    state,
    listen: async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise((r) => server.close(r)),
    mutations: () => calls.filter((c) => c.method !== 'GET'),
  };
}

describe('MediaMTX path sync', () => {
  let app: INestApplication<App>;
  let fake: ReturnType<typeof fakeMediamtx>;
  let fakeUrl: string;
  let sync: PathSync;
  let cookie: string;

  beforeAll(async () => {
    fake = fakeMediamtx();
    fakeUrl = await fake.listen();
  });
  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    fake.paths.clear();
    app = await createTestApp({
      MEDIAMTX_API_URL: fakeUrl,
      MEDIAMTX_PASSWORD: PASSWORD,
    });
    sync = app.get(PathSync);
    cookie = (await asRole(app, 'SUPERADMIN')).cookie;
    await sync.reconcile(); // the one at start
    fake.calls.length = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    id: 'gate_a',
    name: 'Gate A',
    useCase: 'cashier_presence',
    sourceType: 'RTSP',
    mainStreamUrl: URL_MAIN,
    subStreamUrl: URL_SUB,
    settings: validSettings('cashier_presence'),
    ...over,
  });
  const create = (over: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/api/v1/cameras')
      .set('Cookie', cookie)
      .send(body(over));
  const patch = (id: string, data: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/api/v1/cameras/${id}`)
      .set('Cookie', cookie)
      .send(data);

  it('creating a camera with a sub URL adds zv_<id> and zv_<id>_sub, with basic auth', async () => {
    await create().expect(201);
    await sync.reconcile();

    expect([...fake.paths.keys()].sort()).toEqual([
      'zv_gate_a',
      'zv_gate_a_sub',
    ]);
    // the camera's own URL reaches MediaMTX byte for byte
    expect(fake.paths.get('zv_gate_a')).toMatchObject({
      source: URL_MAIN,
      rtspTransport: 'tcp',
      record: true,
      sourceOnDemand: false,
      recordDeleteAfter: '168h0m0s',
    });
    expect(fake.paths.get('zv_gate_a_sub')).toMatchObject({
      source: URL_SUB,
      record: false,
      sourceOnDemand: true,
    });
    expect(fake.calls.every((c) => c.auth === BASIC)).toBe(true);
  });

  it('switching recording to SUB and retention to 3 patches both paths', async () => {
    await create().expect(201);
    await sync.reconcile();
    fake.calls.length = 0;

    await patch('gate_a', {
      recording: { stream: 'SUB', retentionDays: 3 },
    }).expect(200);
    await sync.reconcile();

    expect(fake.paths.get('zv_gate_a')).toMatchObject({
      record: false,
      recordDeleteAfter: '72h0m0s',
    });
    expect(fake.paths.get('zv_gate_a_sub')).toMatchObject({
      record: true,
      recordDeleteAfter: '72h0m0s',
      sourceOnDemand: false,
    });
    expect(fake.mutations().map((c) => c.method)).toEqual(['PATCH', 'PATCH']);
  });

  it('disabling deletes both paths; enabling adds them back', async () => {
    await create().expect(201);
    await sync.reconcile();

    await patch('gate_a', { enabled: false }).expect(200);
    await sync.reconcile();
    expect(fake.paths.size).toBe(0);

    await patch('gate_a', { enabled: true }).expect(200);
    await sync.reconcile();
    expect([...fake.paths.keys()].sort()).toEqual([
      'zv_gate_a',
      'zv_gate_a_sub',
    ]);
  });

  it('reconcile deletes a stale zv_gone and leaves feed_gate and other_path alone', async () => {
    for (const name of ['zv_gone', 'feed_gate', 'other_path']) {
      fake.paths.set(name, { source: 'rtsp://x/y', record: false });
    }
    await sync.reconcile();

    expect([...fake.paths.keys()].sort()).toEqual(['feed_gate', 'other_path']);
    expect(fake.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /v3/config/paths/delete/zv_gone',
    ]);
  });

  it('a second reconcile with nothing changed sends no mutation (72h0m0s equals 3d)', async () => {
    await create({ recording: { retentionDays: 3 } }).expect(201);
    await sync.reconcile();
    expect(fake.paths.get('zv_gate_a')?.recordDeleteAfter).toBe('72h0m0s');
    fake.calls.length = 0;

    await sync.reconcile();
    expect(fake.mutations()).toEqual([]);
  });

  it('MediaMTX answering 503 never fails the save; the next reconcile adds the path', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      fake.state.failing = true;
      await create().expect(201);
      await sync.reconcile();
      expect(fake.paths.size).toBe(0);

      fake.state.failing = false;
      await sync.reconcile();
      expect([...fake.paths.keys()].sort()).toEqual([
        'zv_gate_a',
        'zv_gate_a_sub',
      ]);
      // the log names the path and the status, never the source URL or the password
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain('path zv_gate_a: add failed (503)');
      for (const line of lines) {
        expect(line).not.toContain('p%40ss');
        expect(line).not.toContain(PASSWORD);
        expect(line).not.toContain('10.1.2.3');
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('a camera id ending in _sub is refused', async () => {
    const res = await create({ id: 'gate_sub' }).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a FILE camera adds no path', async () => {
    await create({
      id: 'file_cam',
      sourceType: 'FILE',
      mainStreamUrl: 'sample_data/cars.mp4',
      subStreamUrl: null,
    }).expect(201);
    await sync.reconcile();
    expect(fake.paths.size).toBe(0);
  });
});
