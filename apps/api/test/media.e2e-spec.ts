import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, listenTestApp } from './app';
import { asRole } from './helpers/auth';
import { addCamera, addEvent } from './helpers/analytics';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9,
]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(64, 7),
]);

type PlaybackRequest = {
  url: URL;
  auth: string | undefined;
  closedEarly: boolean;
  finished: boolean;
};

const MEDIAMTX_PASSWORD = 'media-test-pw-0123';

describe('/media', () => {
  let app: INestApplication<App>;
  let base: string;
  let cookie: string;
  let dir: string;
  let root: string;
  let playback: http.Server;
  let playbackUrl: string;
  let seen: PlaybackRequest[];
  /** How the fake MediaMTX answers `/get`: set per test. */
  let answer: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    seenReq: PlaybackRequest,
  ) => void;

  const get = (path: string, session: string | null = cookie) => {
    const req = request(app.getHttpServer()).get(path);
    return session ? req.set('Cookie', session) : req;
  };
  /** A request with the path exactly as written (supertest and URL both tidy up `..`). */
  const raw = (path: string) =>
    new Promise<{ status: number; type: string; body: string }>(
      (resolve, reject) => {
        const { port } = new URL(base);
        http
          .get(
            { host: '127.0.0.1', port, path, headers: { Cookie: cookie } },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (c: string) => (body += c));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  type: String(res.headers['content-type']),
                  body,
                }),
              );
            },
          )
          .on('error', reject);
      },
    );
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const lastPlayback = () => seen[seen.length - 1];

  beforeAll(async () => {
    await resetDb();
    await flushRedis();

    dir = await mkdtemp(join(tmpdir(), 'zoo-media-'));
    root = join(dir, 'snapshots');
    await mkdir(join(root, 'rec', '2026-10-14'), { recursive: true });
    await mkdir(join(dir, 'outside'), { recursive: true });
    await writeFile(join(root, 'rec', '2026-10-14', 'evt_snap.jpg'), JPEG);
    await writeFile(join(dir, 'secret.jpg'), 'TOP SECRET');
    await writeFile(join(dir, 'outside', 'secret.jpg'), 'TOP SECRET');
    await symlink(
      join(dir, 'outside'),
      join(root, 'rec', 'escape'),
      'junction',
    );

    seen = [];
    answer = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(MP4);
    };
    playback = http.createServer((req, res) => {
      const entry: PlaybackRequest = {
        url: new URL(req.url ?? '/', 'http://playback'),
        auth: req.headers.authorization,
        closedEarly: false,
        finished: false,
      };
      seen.push(entry);
      res.on('finish', () => (entry.finished = true));
      res.on('close', () => (entry.closedEarly = !entry.finished));
      answer(req, res, entry);
    });
    await new Promise<void>((r) => playback.listen(0, '127.0.0.1', r));
    playbackUrl = `http://127.0.0.1:${(playback.address() as AddressInfo).port}`;

    app = await createTestApp({
      SNAPSHOT_DIR: root,
      MEDIAMTX_PLAYBACK_URL: playbackUrl,
      MEDIAMTX_PASSWORD,
    });
    base = await listenTestApp(app);
    cookie = (await asRole(app, 'USER')).cookie;

    await addCamera('rec', {
      useCase: 'horse_riding',
      sourceType: 'RTSP',
      clipBeforeSec: 10,
      clipAfterSec: 20,
    });
    // not a camera id the API would accept: proves the path is one encoded value anyway
    await addCamera('we&x=1/../y z', {
      useCase: 'horse_riding',
      sourceType: 'RTSP',
    });
    await addCamera('off', {
      useCase: 'horse_riding',
      sourceType: 'RTSP',
      recordingEnabled: false,
    });
    await addCamera('nopath', { useCase: 'horse_riding' }); // FILE: no MediaMTX path

    const event = (id: string, cameraId: string | null, time: string) =>
      addEvent({
        id,
        time,
        cameraId,
        useCase: cameraId ? 'horse_riding' : 'system',
        type: cameraId ? 'horse_crossing' : 'engine_started',
        data: cameraId
          ? { direction: 'DEPARTURE', trackerId: 1 }
          : { bootId: 'd'.repeat(32), engineGroup: 'default' },
      });
    await event('evt_old', 'rec', '2026-10-14T03:00:00.000Z');
    await event('evt_weird', 'we&x=1/../y z', '2026-10-14T03:00:00.000Z');
    await event('evt_off', 'off', '2026-10-14T03:00:00.000Z');
    await event('evt_nopath', 'nopath', '2026-10-14T03:00:00.000Z');
    await event('evt_system', null, '2026-10-14T03:00:00.000Z');
    // the clip window (time + 20 s) is still running
    await event('evt_fresh', 'rec', new Date(Date.now() - 5_000).toISOString());
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => playback.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen.length = 0;
    answer = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(MP4);
    };
  });

  describe('snapshots', () => {
    it('serves a snapshot to a USER session as image/jpeg; 401 without a session', async () => {
      const res = await get('/media/snapshots/rec/2026-10-14/evt_snap.jpg')
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-length']).toBe(String(JPEG.length));
      expect(Buffer.compare(res.body as Buffer, JPEG)).toBe(0);

      const anonymous = await get(
        '/media/snapshots/rec/2026-10-14/evt_snap.jpg',
        null,
      ).expect(401);
      expect(anonymous.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('a missing file is 404 NOT_FOUND', async () => {
      const res = await get('/media/snapshots/rec/2026-10-14/none.jpg').expect(
        404,
      );
      expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    it('never serves a file from outside the folder: ../, encoded dots, backslashes, NUL, absolute paths, a symlink', async () => {
      const attempts = [
        '/media/snapshots/../secret.jpg',
        '/media/snapshots/rec/../../secret.jpg',
        '/media/snapshots/%2e%2e/secret.jpg',
        '/media/snapshots/rec/%2e%2e/%2e%2e/secret.jpg',
        '/media/snapshots/..%2Fsecret.jpg',
        '/media/snapshots/rec%2F..%2F..%2Fsecret.jpg',
        '/media/snapshots/..%5Csecret.jpg',
        '/media/snapshots/rec%5C..%5C..%5Csecret.jpg',
        '/media/snapshots/%00secret.jpg',
        '/media/snapshots/rec/2026-10-14/evt_snap.jpg%00.png',
        `/media/snapshots/${encodeURIComponent(join(dir, 'secret.jpg'))}`,
        '/media/snapshots//etc/passwd',
        '/media/snapshots/rec/escape/secret.jpg',
      ];
      // the control: the same route does serve a real file, so a 404 below means "refused"
      expect(
        (await raw('/media/snapshots/rec/2026-10-14/evt_snap.jpg')).status,
      ).toBe(200);
      for (const path of attempts) {
        const out = await raw(path);
        expect({
          path,
          status: out.status,
          leaked: out.body.includes('TOP SECRET'),
        }).toEqual({ path, status: 404, leaked: false });
      }
    });

    it('/api/v1/media/snapshots/x is 404: media lives outside the api prefix', async () => {
      await get('/api/v1/media/snapshots/rec/2026-10-14/evt_snap.jpg').expect(
        404,
      );
      await get('/api/v1/media/clips/evt_old').expect(404);
    });
  });

  describe('clips', () => {
    it('asks playback for start = time − clipBeforeSec and duration = before + after, and streams the MP4', async () => {
      const res = await get('/media/clips/evt_old')
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(Buffer.compare(res.body as Buffer, MP4)).toBe(0);

      expect(seen).toHaveLength(1);
      const { url } = seen[0];
      expect(url.pathname).toBe('/get');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        path: 'zv_rec',
        start: '2026-10-14T02:59:50.000Z', // 10 s before 03:00:00
        duration: '30', // 10 + 20
        format: 'mp4',
      });
      // a clip that is over can be cached by the browser, privately
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      // playback wants the MediaMTX service password (user zoo)
      expect(seen[0].auth).toBe(
        `Basic ${Buffer.from(`zoo:${MEDIAMTX_PASSWORD}`).toString('base64')}`,
      );
    });

    it('GET /media/clips/:id for a camera that switched to SUB plays from zv_<id> (I5)', async () => {
      // the event was recorded on MAIN; the camera records the sub stream since
      await ownerQuery(
        `UPDATE "Camera" SET "subStreamUrlEnc" = 'enc', "recordingStream" = 'SUB' WHERE "id" = 'rec'`,
      );
      answer = (_req, res, entry) => {
        const switched = entry.url.searchParams.get('path') === 'zv_rec_sub';
        res.writeHead(switched ? 404 : 200, { 'Content-Type': 'video/mp4' });
        res.end(switched ? undefined : MP4);
      };
      try {
        await get('/media/clips/evt_old').expect(200);
        expect(seen.map((r) => r.url.searchParams.get('path'))).toEqual([
          'zv_rec_sub',
          'zv_rec',
        ]);
      } finally {
        await ownerQuery(
          `UPDATE "Camera" SET "subStreamUrlEnc" = NULL, "recordingStream" = 'MAIN' WHERE "id" = 'rec'`,
        );
      }
    });

    it('no-store for an event whose clip end is in the future', async () => {
      const res = await get('/media/clips/evt_fresh').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('puts the recording path in the query as one encoded value', async () => {
      await get('/media/clips/evt_weird').expect(200);
      const params = seen[0].url.searchParams;
      expect(params.get('path')).toBe('zv_we&x=1/../y z');
      expect(params.has('x')).toBe(false);
      expect([...params.keys()].sort()).toEqual([
        'duration',
        'format',
        'path',
        'start',
      ]);
    });

    it('RECORDING_NOT_AVAILABLE when the camera is a FILE camera, recording is off, or the event has no camera', async () => {
      for (const id of ['evt_nopath', 'evt_off', 'evt_system']) {
        const res = await get(`/media/clips/${id}`).expect(404);
        expect([id, (res.body as { code: string }).code]).toEqual([
          id,
          'RECORDING_NOT_AVAILABLE',
        ]);
      }
      expect(seen).toHaveLength(0); // nobody asked playback
    });

    it('RECORDING_NOT_AVAILABLE when playback answers 404 or an error, or is not there', async () => {
      for (const status of [404, 500]) {
        answer = (_req, res) => {
          res.writeHead(status);
          res.end('no recording');
        };
        const res = await get('/media/clips/evt_old').expect(404);
        expect(res.body).toMatchObject({ code: 'RECORDING_NOT_AVAILABLE' });
      }

      const gone = await createTestApp({
        SNAPSHOT_DIR: root,
        MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:1', // nothing listens
      });
      try {
        const res = await request(gone.getHttpServer())
          .get('/media/clips/evt_old')
          .set('Cookie', cookie)
          .expect(404);
        expect(res.body).toMatchObject({ code: 'RECORDING_NOT_AVAILABLE' });
      } finally {
        await gone.close();
      }
    });

    it('logs why playback failed, without the credentials of its URL or the recording path', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        answer = (_req, res) => {
          res.writeHead(500);
          res.end('boom');
        };
        await get('/media/clips/evt_old').expect(404);

        const gone = await createTestApp({
          SNAPSHOT_DIR: root,
          MEDIAMTX_PLAYBACK_URL: 'http://user:s3cret@127.0.0.1:1',
        });
        try {
          await request(gone.getHttpServer())
            .get('/media/clips/evt_old')
            .set('Cookie', cookie)
            .expect(404);
        } finally {
          await gone.close();
        }

        const lines = warn.mock.calls.map((call) => String(call[0]));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^playback 127\.0\.0\.1:\d+ answered 500$/);
        expect(lines[1]).toMatch(/^playback 127\.0\.0\.1:1 not reachable \(/);
        for (const line of lines) {
          expect(line).not.toContain('s3cret');
          expect(line).not.toContain('cam_rec');
        }
      } finally {
        warn.mockRestore();
      }
    });

    it('a 404 from playback (nothing recorded for that time) is the normal answer and is not logged', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        answer = (_req, res) => {
          res.writeHead(404);
          res.end();
        };
        await get('/media/clips/evt_old').expect(404);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('RECORDING_NOT_AVAILABLE when MEDIAMTX_PLAYBACK_URL is unset', async () => {
      const unset = await createTestApp({ SNAPSHOT_DIR: root });
      try {
        const res = await request(unset.getHttpServer())
          .get('/media/clips/evt_old')
          .set('Cookie', cookie)
          .expect(404);
        expect(res.body).toMatchObject({ code: 'RECORDING_NOT_AVAILABLE' });
      } finally {
        await unset.close();
      }
    });

    it('an unknown event is 404 NOT_FOUND; without a session 401', async () => {
      const res = await get('/media/clips/evt_nope').expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      await get('/media/clips/evt_old', null).expect(401);
    });

    it('the upstream request is aborted when the client goes away', async () => {
      answer = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        const timer = setInterval(() => res.write(Buffer.alloc(1024, 1)), 20);
        res.on('close', () => clearInterval(timer));
      };
      await new Promise<void>((resolve, reject) => {
        const { port } = new URL(base);
        const req = http.get(
          {
            host: '127.0.0.1',
            port,
            path: '/media/clips/evt_old',
            headers: { Cookie: cookie },
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
        });
      });

      for (let i = 0; i < 50 && !lastPlayback()?.closedEarly; i++)
        await wait(50);
      expect(lastPlayback().closedEarly).toBe(true);
    });
  });
});
