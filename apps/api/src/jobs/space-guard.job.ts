import { readdir, rmdir, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ENV, type Env } from '../config/env';
import { usedPercent } from './disk-levels';
import { dirs, RECORDED } from './retention.job';

const INTERVAL_NAME = 'space-guard-job';
const TICK_MS = 5 * 60_000;
/** At or above this share of the recordings disk the guard starts deleting … */
const TRIGGER = 95;
/** … and stops below this one. */
const TARGET = 90;
/** The segment MediaMTX is writing and the footage a pending pin still needs are younger than this. */
const MIN_AGE_MS = 3_600_000;
/** The disk is read again after this many deleted files. */
const RECHECK_EVERY = 20;

type Segment = { path: string; folder: string; mtimeMs: number; size: number };

/**
 * The fallback when the recordings disk is nearly full: from 95% it deletes recording segments
 * (files directly in `zv_*` folders of RECORDINGS_DIR) older than 1 hour, oldest first, until the
 * disk is below 90%. Nothing else is read or deleted: kept clips, snapshots and exports are
 * deliberate, and `feed_*` and any other folder are not ours. No database.
 */
@Injectable()
export class SpaceGuardJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SpaceGuardJob.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (this.env.JOBS !== 'on') return;
    this.scheduler.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), TICK_MS),
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** One pass. Skipped while the previous pass runs; never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const root = this.env.RECORDINGS_DIR;
      const before = usedPercent(await statfs(root));
      if (before < TRIGGER) return;

      const eligible = (await this.segments(root)).filter(
        (s) => s.mtimeMs < now.getTime() - MIN_AGE_MS,
      );
      eligible.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      let failed = 0;
      let bytes = 0;
      let after = before;
      let left = eligible.length;
      const touched = new Set<string>();
      for (const s of eligible) {
        left--;
        touched.add(s.folder);
        try {
          await unlink(s.path);
          deleted++;
          bytes += s.size;
        } catch (err) {
          // ENOENT: gone already (MediaMTX or a person); EACCES etc.: counted, the file stays
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') deleted++;
          else failed++;
        }
        if ((deleted + failed) % RECHECK_EVERY === 0) {
          after = usedPercent(await statfs(root));
          if (after < TARGET) break;
        }
      }
      if (deleted + failed > 0) after = usedPercent(await statfs(root));
      for (const folder of touched) await rmdir(folder).catch(() => undefined); // only an empty folder goes

      if (deleted || failed) {
        this.log.log(
          `space guard: disk ${before}% → ${after}%, deleted ${deleted} recordings (${(bytes / 2 ** 30).toFixed(2)} GiB), failed ${failed}`,
        );
      }
      if (after >= TRIGGER && left === 0) {
        this.log.warn(
          `recordings disk is ${after}% used and no more recordings older than 1 hour can be deleted`,
        );
      }
    } catch (err) {
      // no recordings folder yet: nothing to guard (DiskJob says so once)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`space guard failed: ${(err as Error).message}`);
      }
    } finally {
      this.running = false;
    }
  }

  /** The regular files directly in `zv_<id>` and `zv_<id>_sub` folders; a symlink or a sub-folder is not one. */
  private async segments(root: string): Promise<Segment[]> {
    const out: Segment[] = [];
    for (const name of await dirs(root)) {
      if (!RECORDED.test(name)) continue;
      const folder = join(root, name);
      try {
        for (const f of await readdir(folder, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          const path = join(folder, f.name);
          const s = await stat(path).catch(() => null); // gone since the listing
          if (s) out.push({ path, folder, mtimeMs: s.mtimeMs, size: s.size });
        }
      } catch (err) {
        this.log.warn(`cannot list ${name}: ${(err as Error).message}`);
      }
    }
    return out;
  }
}
