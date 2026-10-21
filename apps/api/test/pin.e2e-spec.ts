import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, Logger } from '@nestjs/common';
import { App } from 'supertest/types';
import { PinJob } from '../src/evidence/pin.job';
import { createTestApp } from './app';
import { addCamera, addEvent } from './helpers/analytics';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(64, 9),
]);
const EVENT_TIME = '2026-10-14T03:00:00.000Z';
const NOW = new Date('2026-10-14T05:00:00.000Z');

type Row = {
  eventId: string;
  status: string;
  attempts: number;
  error: string | null;
  filePath: string | null;
  sizeBytes: number | null;
  runAt: Date;
};

describe('PinJob: kept clips', () => {
  let app: INestApplication<App>;
  let dir: string;
  let evidenceDir: string;
  let playback: http.Server;
  let seen: string[];
  /** What the fake playback answers for a recording path. */
  let answer: (path: string) => number;

  const tick = (now = NOW) => app.get(PinJob).tick(now);
  const row = async (eventId: string) =>
    (
      (await ownerQuery(
        `SELECT "eventId", "status", "attempts", "error", "filePath", "sizeBytes", "runAt"
         FROM "Evidence" WHERE "eventId" = $1`,
        eventId,
      )) as Row[]
    )[0];
  /** An event with a QUEUED evidence row that is already due. */
  const queue = async (
    id: string,
    cameraId = 'pin_cam',
    rowCamera = cameraId,
  ) => {
    await addEvent({
      id,
      time: EVENT_TIME,
      cameraId,
      useCase: 'cashier_presence',
      type: 'cashier_unattended',
      severity: 'warning',
    });
    await ownerQuery(
      `INSERT INTO "Evidence" ("eventId", "cameraId", "eventTime", "reason", "runAt")
       VALUES ($1, $2, $3, 'SEVERITY', '2026-10-14T00:00:00Z')`,
      id,
      rowCamera,
      EVENT_TIME,
    );
  };

  beforeAll(async () => {
    seen = [];
    playback = http.createServer((req, res) => {
      const path =
        new URL(req.url ?? '/', 'http://playback').searchParams.get('path') ??
        '';
      seen.push(path);
      const status = answer(path);
      res.writeHead(status, { 'Content-Type': 'video/mp4' });
      res.end(status === 200 ? MP4 : 'no');
    });
    await new Promise<void>((r) => playback.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise((r) => playback.close(r));
  });

  const start = async (env: Record<string, string> = {}) => {
    dir = await mkdtemp(join(tmpdir(), 'zoo-pin-'));
    evidenceDir = join(dir, 'evidence');
    app = await createTestApp({
      EVIDENCE_DIR: evidenceDir,
      MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${(playback.address() as AddressInfo).port}`,
      ...env,
    });
  };

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    seen.length = 0;
    answer = () => 200;
    await addCamera('pin_cam', { sourceType: 'RTSP' });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('fake answers 200 with bytes → KEPT, file at <cam>/<date>/<evt>.mp4 with those bytes, sizeBytes, no .part left', async () => {
    await start();
    await queue('evt_ok');
    await tick();
    expect(await row('evt_ok')).toMatchObject({
      status: 'KEPT',
      filePath: 'pin_cam/2026-10-14/evt_ok.mp4',
      sizeBytes: MP4.length,
      error: null,
    });
    const folder = join(evidenceDir, 'pin_cam', '2026-10-14');
    expect(await readdir(folder)).toEqual(['evt_ok.mp4']);
    const bytes = await readFile(join(folder, 'evt_ok.mp4'));
    expect(Buffer.compare(bytes, MP4)).toBe(0);
  });

  it('404 on both zv_<id> and zv_<id>_sub → NO_RECORDING, no file', async () => {
    await start();
    await queue('evt_none');
    answer = () => 404;
    await tick();
    expect(await row('evt_none')).toMatchObject({ status: 'NO_RECORDING' });
    expect(seen).toEqual(['zv_pin_cam', 'zv_pin_cam_sub']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('404 on zv_<id> and 400 on a never-recorded zv_<id>_sub (MediaMTX 1.21) → NO_RECORDING, not a retry', async () => {
    await start();
    await queue('evt_400');
    answer = (path) => (path.endsWith('_sub') ? 400 : 404);
    await tick();
    expect(await row('evt_400')).toMatchObject({
      status: 'NO_RECORDING',
      attempts: 0,
    });
  });

  it('camera now records SUB: 404 on zv_<id>_sub, 200 on zv_<id> → KEPT', async () => {
    await start();
    await ownerQuery(
      `UPDATE "Camera" SET "subStreamUrlEnc" = 'enc', "recordingStream" = 'SUB' WHERE "id" = 'pin_cam'`,
    );
    await queue('evt_sub');
    answer = (path) => (path === 'zv_pin_cam_sub' ? 404 : 200);
    await tick();
    expect(seen).toEqual(['zv_pin_cam_sub', 'zv_pin_cam']);
    expect(await row('evt_sub')).toMatchObject({ status: 'KEPT' });
  });

  it('500 → attempts 1, runAt +1 min; after the 9th 500 → FAILED', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await start();
      await queue('evt_500');
      answer = () => 500;
      await tick();
      const first = await row('evt_500');
      expect(first).toMatchObject({ status: 'QUEUED', attempts: 1 });
      expect(first.runAt.getTime()).toBe(NOW.getTime() + 60_000);

      // not due yet: the same instant changes nothing
      await tick();
      expect((await row('evt_500')).attempts).toBe(1);

      let now = NOW;
      for (let n = 2; n <= 9; n++) {
        now = new Date(now.getTime() + 3 * 3600_000);
        await tick(now);
        if (n < 9) {
          const r = await row('evt_500');
          expect(r).toMatchObject({ status: 'QUEUED', attempts: n });
          expect(r.runAt.getTime()).toBe(now.getTime() + 2 ** (n - 1) * 60_000);
        }
      }
      expect(await row('evt_500')).toMatchObject({
        status: 'FAILED',
        attempts: 9,
        error: 'recording service unavailable',
      });
      // the log names the host, never the recording path or the time window
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toMatch(/answered 500/);
      expect(logged).not.toMatch(/zv_|start=/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a row with cameraId "../x" → FAILED "invalid id", nothing written outside EVIDENCE_DIR', async () => {
    await start();
    const bad = ['../x', 'a/b', 'a\\b', ''];
    for (const [i, id] of bad.entries()) {
      await queue(`evt_bad${i}`, 'pin_cam', id);
    }
    await tick();
    for (const i of bad.keys()) {
      expect(await row(`evt_bad${i}`)).toMatchObject({
        status: 'FAILED',
        error: 'invalid id',
      });
    }
    expect(seen).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('no MEDIAMTX_PLAYBACK_URL → NO_RECORDING', async () => {
    await start({ MEDIAMTX_PLAYBACK_URL: '' });
    await queue('evt_nourl');
    await tick();
    expect(await row('evt_nourl')).toMatchObject({ status: 'NO_RECORDING' });
  });
});
