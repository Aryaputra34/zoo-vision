import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { DiskJob } from '../src/jobs/disk.job';
import { LiveGateway } from '../src/live/live.gateway';
import { createTestApp } from './app';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

/** What the disk reports; the job reads it through statfs. */
let usedPercent = 0;
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
  statfs: () =>
    Promise.resolve({
      blocks: 1000,
      bfree: 1000 - usedPercent * 10,
      bavail: 1000 - usedPercent * 10,
      bsize: 4096,
    }),
}));

describe('DiskJob: one event per crossing', () => {
  let app: INestApplication<App>;
  let dir: string;

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    dir = await mkdtemp(join(tmpdir(), 'zoo-disk-'));
    // the four folders on one disk: it must be counted once
    app = await createTestApp({
      RECORDINGS_DIR: dir,
      SNAPSHOT_DIR: dir,
      EVIDENCE_DIR: dir,
      EXPORTS_DIR: dir,
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('80 → 97 → 94 → 96: one critical event and one disk.warning, none for the others', async () => {
    const sent = jest
      .spyOn(app.get(LiveGateway), 'toManagers')
      .mockImplementation(() => undefined);
    for (usedPercent of [80, 97, 94, 96]) await app.get(DiskJob).tick();
    const rows = (await ownerQuery(
      `SELECT "type", "severity", "cameraId", "data" FROM "Event" WHERE "useCase" = 'system'`,
    )) as { type: string; severity: string; cameraId: null; data: object }[];
    expect(rows).toEqual([
      {
        type: 'disk_low',
        severity: 'critical',
        cameraId: null,
        data: { path: dir, usedPercent: 97, freeBytes: 30 * 4096 },
      },
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(
      'disk.warning',
      expect.objectContaining({ path: dir, severity: 'critical' }),
    );
  });
});
