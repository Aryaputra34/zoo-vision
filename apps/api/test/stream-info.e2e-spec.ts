import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StreamInfoService } from '../src/mediamtx/stream-info.service';
import { createTestApp } from './app';
import { asRole } from './helpers/auth';
import { validSettings } from './helpers/settings';
import { flushRedis, resetDb } from './setup/db';

const PASSWORD = 'mtx-test-pw-0123456789';
const BASIC = `Basic ${Buffer.from(`zoo:${PASSWORD}`).toString('base64')}`;

type Status = {
  ready: boolean;
  tracks2: { codec: string }[];
  bytesReceived: number;
};

describe('GET /cameras/:id/stream-info', () => {
  let app: INestApplication<App>;
  let server: http.Server;
  let url: string;
  let cookie: string;
  /** What the fake MediaMTX answers on /v3/paths/get/<name>; a missing name is 404. */
  const statuses = new Map<string, Status>();
  let now = 1_000_000;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
      const status = statuses.get(name);
      const ok = req.headers.authorization === BASIC && status;
      res.writeHead(
        req.headers.authorization !== BASIC ? 401 : ok ? 200 : 404,
        {
          'Content-Type': 'application/json',
        },
      );
      res.end(JSON.stringify(ok ? { name, ...status } : { status: 'error' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    statuses.clear();
    now = 1_000_000;
    app = await createTestApp({
      MEDIAMTX_API_URL: url,
      MEDIAMTX_PASSWORD: PASSWORD,
      RECORDINGS_DIR: tmpdir(),
    });
    app.get(StreamInfoService).now = () => now;
    cookie = (await asRole(app, 'SUPERADMIN')).cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  const make = (over: Record<string, unknown> = {}, target = app) =>
    request(target.getHttpServer())
      .post('/api/v1/cameras')
      .set('Cookie', cookie)
      .send({
        id: 'cam_si',
        name: 'Cam',
        useCase: 'cashier_presence',
        sourceType: 'RTSP',
        mainStreamUrl: 'rtsp://u:p@10.1.2.3/main',
        subStreamUrl: 'rtsp://u:p@10.1.2.3/sub',
        settings: validSettings('cashier_presence'),
        ...over,
      })
      .expect(201);
  const info = (id = 'cam_si', session = cookie, target = app) =>
    request(target.getHttpServer())
      .get(`/api/v1/cameras/${id}/stream-info`)
      .set('Cookie', session);
  const up = (codec: string, bytesReceived = 0): Status => ({
    ready: true,
    tracks2: [{ codec }],
    bytesReceived,
  });

  type Path = {
    name: string;
    stream: string;
    ready: boolean;
    recorded: boolean;
    codecs: string[];
    codecWarning: string | null;
    bitrateBps: number | null;
    estimatedBytes: number | null;
  };
  const paths = (body: unknown) => (body as { paths: Path[] }).paths;

  it('an H265 track gives codecWarning H265_BROWSER, H264 gives null; a path MediaMTX lacks is not ready', async () => {
    await make();
    statuses.set('zv_cam_si', up('H265'));
    const res = await info().expect(200);
    const [main, sub] = paths(res.body);
    expect(main).toMatchObject({
      name: 'zv_cam_si',
      stream: 'MAIN',
      ready: true,
      codecs: ['H265'],
      codecWarning: 'H265_BROWSER',
    });
    expect(sub).toMatchObject({
      name: 'zv_cam_si_sub',
      stream: 'SUB',
      ready: false,
      codecs: [],
      codecWarning: null,
    });

    statuses.set('zv_cam_si', up('H264'));
    expect(paths((await info().expect(200)).body)[0].codecWarning).toBeNull();
  });

  it('the first call has no bitrate; a second one 10 s later with +5,000,000 bytes gives 4,000,000', async () => {
    await make();
    statuses.set('zv_cam_si', up('H264', 1_000_000));
    expect(paths((await info().expect(200)).body)[0].bitrateBps).toBeNull();

    now += 10_000;
    statuses.set('zv_cam_si', up('H264', 6_000_000));
    expect(paths((await info().expect(200)).body)[0].bitrateBps).toBe(
      4_000_000,
    );

    // two readings more than 120 s apart say nothing
    now += 200_000;
    statuses.set('zv_cam_si', up('H264', 9_000_000));
    expect(paths((await info().expect(200)).body)[0].bitrateBps).toBeNull();
  });

  it('only the recorded path carries estimatedBytes: bitrate / 8 x 86400 x retentionDays', async () => {
    await make({ recording: { retentionDays: 3 } });
    statuses.set('zv_cam_si', up('H264', 0));
    statuses.set('zv_cam_si_sub', up('H264', 0));
    await info().expect(200);
    now += 10_000;
    statuses.set('zv_cam_si', up('H264', 5_000_000));
    statuses.set('zv_cam_si_sub', up('H264', 5_000_000));

    const [main, sub] = paths((await info().expect(200)).body);
    expect(main).toMatchObject({ recorded: true, bitrateBps: 4_000_000 });
    expect(main.estimatedBytes).toBe((4_000_000 / 8) * 86400 * 3);
    expect(sub).toMatchObject({ recorded: false, estimatedBytes: null });
  });

  it('disk free and total come from the recordings volume', async () => {
    await make();
    const { disk } = (await info().expect(200)).body as {
      disk: { freeBytes: number; totalBytes: number };
    };
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
  });

  it('a USER gets 403, an unknown camera 404, a FILE camera 200 with no paths', async () => {
    await make();
    await make({
      id: 'cam_file',
      sourceType: 'FILE',
      mainStreamUrl: 'sample_data/cars.mp4',
      subStreamUrl: null,
    });
    const user = (await asRole(app, 'USER')).cookie;
    await info('cam_si', user).expect(403);
    await info('nope_cam').expect(404);
    const file = await info('cam_file').expect(200);
    expect(paths(file.body)).toEqual([]);
  });

  it('MediaMTX down → 503 UNAVAILABLE; without MEDIAMTX_API_URL → 503', async () => {
    await make();
    const down = await createTestApp({
      MEDIAMTX_API_URL: 'http://127.0.0.1:1',
      MEDIAMTX_PASSWORD: PASSWORD,
    });
    try {
      const res = await info('cam_si', cookie, down).expect(503);
      expect(res.body).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await down.close();
    }

    const none = await createTestApp();
    try {
      const res = await info('cam_si', cookie, none).expect(503);
      expect(res.body).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await none.close();
    }
  });
});
