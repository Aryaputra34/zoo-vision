import http from 'node:http';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { REDIS } from '../src/redis/redis.constants';
import { createTestApp, listenTestApp } from './app';
import { addCamera } from './helpers/analytics';
import { asRole } from './helpers/auth';
import { flushRedis, resetDb } from './setup/db';

const SAMPLE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]);

describe('Debug view MJPEG stream /media/debug/:id', () => {
  let app: INestApplication<App>;
  let base: string;
  let redis: Redis;
  let pubClient: Redis;
  let managerCookie: string;
  let superadminCookie: string;
  let port: number;
  let activeStreams: Array<{
    req: http.ClientRequest;
    res?: http.IncomingMessage;
  }> = [];

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const numsub = async (channel: string): Promise<number> => {
    const res = (await redis.call('PUBSUB', 'NUMSUB', channel)) as [
      string,
      number,
    ];
    return Number(res[1]);
  };

  const openStream = (
    cameraId: string,
    cookie: string,
  ): Promise<{
    req: http.ClientRequest;
    res: http.IncomingMessage;
    readChunk: () => Promise<Buffer>;
  }> => {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let waitingResolve: ((chunk: Buffer) => void) | null = null;

      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `/media/debug/${cameraId}`,
        method: 'GET',
        headers: { Cookie: cookie },
      });

      const entry: { req: http.ClientRequest; res?: http.IncomingMessage } = {
        req,
      };
      activeStreams.push(entry);

      req.on('response', (res) => {
        entry.res = res;
        res.on('data', (chunk: Buffer) => {
          if (waitingResolve) {
            const cb = waitingResolve;
            waitingResolve = null;
            cb(chunk);
          } else {
            chunks.push(chunk);
          }
        });

        const readChunk = (): Promise<Buffer> => {
          if (chunks.length > 0) {
            return Promise.resolve(chunks.shift()!);
          }
          return new Promise((r) => {
            waitingResolve = r;
          });
        };

        resolve({ req, res, readChunk });
      });

      req.on('error', reject);
      req.end();
    });
  };

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    app = await createTestApp();
    base = await listenTestApp(app);
    port = Number(new URL(base).port);
    redis = app.get<Redis>(REDIS);
    pubClient = redis.duplicate();

    managerCookie = (await asRole(app, 'MANAGER')).cookie;
    superadminCookie = (await asRole(app, 'SUPERADMIN')).cookie;

    await addCamera('cam_debug_view');
  });

  afterEach(() => {
    for (const s of activeStreams) {
      s.req.destroy();
      s.res?.destroy();
    }
    activeStreams = [];
  });

  afterAll(async () => {
    for (const s of activeStreams) {
      s.req.destroy();
      s.res?.destroy();
    }
    activeStreams = [];
    if (pubClient) {
      pubClient.disconnect();
    }
    await app.close();
  });

  it('a MANAGER → 403; an unknown camera → 404 JSON', async () => {
    // MANAGER gets 403
    await request(app.getHttpServer())
      .get('/media/debug/cam_debug_view')
      .set('Cookie', managerCookie)
      .expect(403);

    // SUPERADMIN with unknown camera gets 404 JSON
    const res = await request(app.getHttpServer())
      .get('/media/debug/cam_nonexistent')
      .set('Cookie', superadminCookie)
      .expect(404);

    expect(res.headers['content-type']).toContain('application/json');
    expect((res.body as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('a SUPERADMIN stream: TTL of cam:<id>:debug stays above 0 for 6 s; a published JPEG arrives as one part', async () => {
    const stream = await openStream('cam_debug_view', superadminCookie);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toBe(
      'multipart/x-mixed-replace; boundary=frame',
    );
    expect(stream.res.headers['cache-control']).toBe('no-store');
    expect(stream.res.headers['x-content-type-options']).toBe('nosniff');

    const key = 'cam:cam_debug_view:debug';
    const channel = 'cam:cam_debug_view:debugframes';

    // Verify TTL stays above 0 for 6 seconds
    const start = Date.now();
    while (Date.now() - start < 6000) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      await wait(1000);
    }

    // Publish a JPEG frame
    const readPromise = stream.readChunk();
    await pubClient.publish(channel, SAMPLE_JPEG);

    const chunk = await readPromise;
    const chunkStr = chunk.toString();
    expect(chunkStr).toContain('--frame\r\nContent-Type: image/jpeg');
    expect(chunkStr).toContain(`Content-Length: ${SAMPLE_JPEG.length}\r\n\r\n`);
    expect(chunk.includes(SAMPLE_JPEG)).toBe(true);

    stream.req.destroy();
    stream.res.destroy();
  }, 15000);

  it('the client destroys the socket → within 6 s the key is gone and NUMSUB cam:<id>:debugframes is 0', async () => {
    const stream = await openStream('cam_debug_view', superadminCookie);
    expect(stream.res.statusCode).toBe(200);

    const key = 'cam:cam_debug_view:debug';
    const channel = 'cam:cam_debug_view:debugframes';

    // Wait until key is set and pubsub subscription is active
    let num = 0;
    for (let i = 0; i < 20; i++) {
      num = await numsub(channel);
      if (num === 1) break;
      await wait(50);
    }
    expect(num).toBe(1);
    expect(await redis.exists(key)).toBe(1);

    // Destroy socket
    stream.req.destroy();
    stream.res.destroy();

    // Within 6 seconds (TTL is 5s, refresh timer stopped), key must expire and NUMSUB must be 0
    let keyExpired = false;
    let numsubZero = false;
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      if ((await redis.exists(key)) === 0) {
        keyExpired = true;
      }
      if ((await numsub(channel)) === 0) {
        numsubZero = true;
      }
      if (keyExpired && numsubZero) break;
      await wait(300);
    }

    expect(numsubZero).toBe(true);
    expect(keyExpired).toBe(true);
  }, 15000);

  it('two viewers, one leaves → the key is still refreshed', async () => {
    const key = 'cam:cam_debug_view:debug';
    const channel = 'cam:cam_debug_view:debugframes';

    const viewer1 = await openStream('cam_debug_view', superadminCookie);
    const viewer2 = await openStream('cam_debug_view', superadminCookie);

    expect(viewer1.res.statusCode).toBe(200);
    expect(viewer2.res.statusCode).toBe(200);

    // Wait for subscription
    for (let i = 0; i < 20; i++) {
      if ((await numsub(channel)) === 1) break;
      await wait(50);
    }
    expect(await numsub(channel)).toBe(1);

    // Viewer 1 leaves
    viewer1.req.destroy();
    viewer1.res.destroy();

    // Wait 3 seconds: key must still be refreshed because viewer2 is still watching
    await wait(3000);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(await numsub(channel)).toBe(1);

    // Verify viewer 2 still receives published frames
    const readPromise = viewer2.readChunk();
    await pubClient.publish(channel, SAMPLE_JPEG);
    const chunk = await readPromise;
    expect(chunk.includes(SAMPLE_JPEG)).toBe(true);

    // Viewer 2 leaves
    viewer2.req.destroy();
    viewer2.res.destroy();

    // Within 6s, key expires and numsub is 0
    let keyExpired = false;
    let numsubZero = false;
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      if ((await redis.exists(key)) === 0) keyExpired = true;
      if ((await numsub(channel)) === 0) numsubZero = true;
      if (keyExpired && numsubZero) break;
      await wait(300);
    }

    expect(numsubZero).toBe(true);
    expect(keyExpired).toBe(true);
  }, 20000);
});
