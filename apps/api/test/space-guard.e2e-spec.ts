import { readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { SpaceGuardJob } from '../src/jobs/space-guard.job';
import { createTestApp } from './app';

const NOW = new Date('2026-10-19T05:00:00.000Z');
/** The recordings folder the mocked disk reads: 80% plus a quarter point per regular file in its zv_* folders. */
let recordings = '';
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
  statfs: () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let files = 0;
    for (const d of fs.readdirSync(recordings, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('zv_')) continue;
      files += fs
        .readdirSync(`${recordings}/${d.name}`, { withFileTypes: true })
        .filter((f) => f.isFile()).length;
    }
    const used = (80 + files / 4) * 10; // of 1000 blocks
    return Promise.resolve({
      blocks: 1000,
      bfree: 1000 - used,
      bavail: 1000 - used,
      bsize: 4096,
    });
  },
}));

describe('SpaceGuardJob: recordings go first, nothing else does', () => {
  let app: INestApplication<App>;
  let dir: string;
  const at = (...parts: string[]) => join(dir, ...parts);

  /** A file whose mtime is `minutes` before NOW. */
  const put = async (path: string, minutes: number) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x');
    const t = new Date(NOW.getTime() - minutes * 60_000);
    await utimes(path, t, t);
  };
  const names = (folder: string) => readdirSync(at(folder)).sort();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoo-space-'));
    recordings = at('recordings');
    app = await createTestApp({
      RECORDINGS_DIR: recordings,
      SNAPSHOT_DIR: at('snapshots'),
      EVIDENCE_DIR: at('evidence'),
      EXPORTS_DIR: at('exports'),
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(recordings, { recursive: true });
  });

  const tick = () => app.get(SpaceGuardJob).tick(NOW);

  it('96%: the oldest zv_* files go first until under 90%; a 59-minute-old file, feed_x/, a symlink, EVIDENCE_DIR and SNAPSHOT_DIR stay', async () => {
    // 62 old files in two camera folders, ages 2 h … 63 h (file n is n + 1 hours old), and a fresh one
    for (let n = 0; n < 62; n++) {
      const folder = n % 2 === 0 ? 'zv_a' : 'zv_b_sub';
      await put(at('recordings', folder, `s${n}.mp4`), (n + 2) * 60);
    }
    await put(at('recordings/zv_a/fresh.mp4'), 59);
    await put(at('recordings/zv_a/deep/old.mp4'), 5000); // not directly in the folder
    await put(at('recordings/feed_x/old.mp4'), 5000);
    await put(at('recordings/other/old.mp4'), 5000);
    await put(at('snapshots/a/2026-01-01/old.jpg'), 5000);
    await put(at('evidence/a/2026-01-01/old.mp4'), 5000);
    await put(at('exports/old.pdf'), 5000);
    await put(at('outside.mp4'), 5000);
    // a symlink needs a privilege on Windows: without it that one check is skipped
    const linked = await symlink(
      at('outside.mp4'),
      at('recordings/zv_a/link.mp4'),
    )
      .then(() => true)
      .catch(() => false);

    await tick();

    // 64 regular files = 96%; every 20 deleted files the disk is read again: 44 files = 91%
    // (go on), 24 files = 86% (stop): the 40 oldest are gone, the 22 youngest old ones stay
    const left = (await readdir(at('recordings/zv_a'))).concat(
      (await readdir(at('recordings/zv_b_sub'))).map((n) => `b:${n}`),
    );
    const oldLeft = [...Array(62).keys()]
      .filter((n) => left.includes(n % 2 === 0 ? `s${n}.mp4` : `b:s${n}.mp4`))
      .sort((a, b) => a - b);
    // file n is (n + 2) hours old, so the oldest are the highest n
    expect(oldLeft).toEqual([...Array(22).keys()]);
    expect(left).toContain('fresh.mp4');
    expect(names('recordings/zv_a/deep')).toEqual(['old.mp4']);
    if (linked) expect(left).toContain('link.mp4');
    expect(names('recordings/feed_x')).toEqual(['old.mp4']);
    expect(names('recordings/other')).toEqual(['old.mp4']);
    expect(names('snapshots/a/2026-01-01')).toEqual(['old.jpg']);
    expect(names('evidence/a/2026-01-01')).toEqual(['old.mp4']);
    expect(names('exports')).toEqual(['old.pdf']);
    expect(names('.')).toContain('outside.mp4');
  });

  it('94% → nothing is deleted', async () => {
    for (let n = 0; n < 56; n++) {
      await put(at('recordings/zv_a', `s${n}.mp4`), (n + 2) * 60);
    }
    await tick();
    expect(names('recordings/zv_a')).toHaveLength(56);
  });
});
