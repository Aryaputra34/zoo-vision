import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { RetentionJob } from '../src/jobs/retention.job';
import { createTestApp } from './app';
import { addCamera, addEvent } from './helpers/analytics';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

// 12:00 in Jakarta, so the local date is also 2026-10-19
const NOW = new Date('2026-10-19T05:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('RetentionJob: what it deletes and what it leaves', () => {
  let app: INestApplication<App>;
  let dir: string;
  const at = (...parts: string[]) => join(dir, ...parts);

  /** A file with the given age (mtime), folders made as needed. */
  const put = async (path: string, days = 0) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x');
    await utimes(path, ago(days), ago(days));
  };
  const evidence = (
    eventId: string,
    cameraId: string,
    status: string,
    eventDays: number,
    filePath: string | null = null,
  ) =>
    ownerQuery(
      `INSERT INTO "Evidence" ("eventId", "cameraId", "eventTime", "reason", "status", "runAt", "filePath")
       VALUES ($1, $2, $3, 'SEVERITY', $4::"EvidenceStatus", $3, $5)`,
      eventId,
      cameraId,
      ago(eventDays),
      status,
      filePath,
    );
  const event = (id: string, cameraId: string, eventDays: number) =>
    addEvent({
      id,
      time: ago(eventDays).toISOString(),
      cameraId,
      useCase: 'cashier_presence',
      type: 'cashier_unattended',
      severity: 'warning',
    });
  const rows = async (table: string, column: string) =>
    (
      (await ownerQuery(
        `SELECT "${column}" AS id FROM "${table}" ORDER BY 1`,
      )) as { id: string }[]
    ).map((r) => r.id);

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    dir = await mkdtemp(join(tmpdir(), 'zoo-retention-'));
    app = await createTestApp({
      SNAPSHOT_DIR: at('snapshots'),
      EVIDENCE_DIR: at('evidence'),
      EXPORTS_DIR: at('exports'),
      RECORDINGS_DIR: at('recordings'),
    });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const tick = () => app.get(RetentionJob).tick(NOW);

  it('snapshot folders older than 90 days go; a kept event JPEG and its folder stay; a folder "tmp" and a fake date stay', async () => {
    await addCamera('cam1');
    await event('evt_keep', 'cam1', 91);
    await evidence('evt_keep', 'cam1', 'NO_RECORDING', 91);
    await put(at('snapshots/cam1/2026-07-20/evt_keep.jpg'));
    await put(at('snapshots/cam1/2026-07-20/evt_drop.jpg'));
    await put(at('snapshots/cam1/2026-07-01/evt_old.jpg'));
    await put(at('snapshots/cam1/2026-07-21/evt_fresh.jpg')); // exactly 90 days: stays
    await put(at('snapshots/cam1/tmp/x.jpg'));
    await put(at('snapshots/cam1/2026-02-30/x.jpg'));
    await tick();
    expect((await readdir(at('snapshots/cam1'))).sort()).toEqual([
      '2026-02-30',
      '2026-07-20',
      '2026-07-21',
      'tmp',
    ]);
    expect(await readdir(at('snapshots/cam1/2026-07-20'))).toEqual([
      'evt_keep.jpg',
    ]);
    expect(existsSync(at('snapshots/cam1/2026-07-21/evt_fresh.jpg'))).toBe(
      true,
    );
  });

  it('an audit camera keeps its snapshots 365 days', async () => {
    await addCamera('aud');
    await ownerQuery(
      `UPDATE "Camera" SET "auditCamera" = true WHERE "id" = 'aud'`,
    );
    await put(at('snapshots/aud/2026-01-01/a.jpg')); // 291 days old
    await tick();
    expect(existsSync(at('snapshots/aud/2026-01-01/a.jpg'))).toBe(true);
  });

  it('evidenceRetentionDays 30 loses the 31-day-old clip file and row, another camera keeps it; a QUEUED row and a fresh .part stay, an old .part goes', async () => {
    await addCamera('c30');
    await addCamera('c365');
    await ownerQuery(
      `UPDATE "Camera" SET "evidenceRetentionDays" = 30 WHERE "id" = 'c30'`,
    );
    for (const [id, cam] of [
      ['evt_a', 'c30'],
      ['evt_b', 'c365'],
      ['evt_q', 'c30'],
    ]) {
      await event(id, cam, 31);
    }
    await put(at('evidence/c30/2026-09-18/evt_a.mp4'), 31);
    await put(at('evidence/c365/2026-09-18/evt_b.mp4'), 31);
    await evidence('evt_a', 'c30', 'KEPT', 31, 'c30/2026-09-18/evt_a.mp4');
    await evidence('evt_b', 'c365', 'KEPT', 31, 'c365/2026-09-18/evt_b.mp4');
    await evidence('evt_q', 'c30', 'QUEUED', 31);
    await put(at('evidence/c365/2026-09-18/old.mp4.part'), 1);
    await put(at('evidence/c365/2026-09-18/fresh.mp4.part'), 0);
    await tick();
    expect(await rows('Evidence', 'eventId')).toEqual(['evt_b', 'evt_q']);
    expect(existsSync(at('evidence/c30/2026-09-18/evt_a.mp4'))).toBe(false);
    expect((await readdir(at('evidence/c365/2026-09-18'))).sort()).toEqual([
      'evt_b.mp4',
      'fresh.mp4.part',
    ]);
  });

  it('a row whose file path leaves the evidence folder keeps its row and deletes nothing outside', async () => {
    await addCamera('cam1');
    await event('evt_x', 'cam1', 400);
    await put(at('outside.txt'));
    await evidence('evt_x', 'cam1', 'KEPT', 400, '../outside.txt');
    await tick();
    expect(existsSync(at('outside.txt'))).toBe(true);
    expect(await rows('Evidence', 'eventId')).toEqual(['evt_x']);
  });

  it('export files finished over 7 days ago expire; younger ones stay', async () => {
    await put(at('exports/old.pdf'));
    await put(at('exports/new.pdf'));
    for (const [name, days] of [
      ['old', 8],
      ['new', 6],
    ] as const) {
      await ownerQuery(
        `INSERT INTO "ExportJob" ("id", "params", "status", "filePath", "finishedAt", "createdById", "createdByName")
         VALUES (gen_random_uuid(), '{}', 'DONE', $1, $2, 'u1', 'U')`,
        `${name}.pdf`,
        ago(days),
      );
    }
    await tick();
    expect(await readdir(at('exports'))).toEqual(['new.pdf']);
    expect(await rows('ExportJob', 'status').then((s) => s.sort())).toEqual([
      'DONE',
      'EXPIRED',
    ]);
  });

  it('zv_gone/ (no camera) old segment deleted, folder removed; zv_<existing>/ and feed_x/ untouched', async () => {
    await addCamera('live');
    await put(at('recordings/zv_gone/a.mp4'), 10);
    await put(at('recordings/zv_gone_sub/old.mp4'), 10);
    await put(at('recordings/zv_gone_sub/new.mp4'), 1);
    await put(at('recordings/zv_live/a.mp4'), 10);
    await put(at('recordings/zv_live_sub/a.mp4'), 10);
    await put(at('recordings/feed_x/a.mp4'), 10);
    await tick();
    expect((await readdir(at('recordings'))).sort()).toEqual([
      'feed_x',
      'zv_gone_sub',
      'zv_live',
      'zv_live_sub',
    ]);
    expect(await readdir(at('recordings/zv_gone_sub'))).toEqual(['new.mp4']);
    expect(existsSync(at('recordings/zv_live/a.mp4'))).toBe(true);
  });
});
