import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ENV, type Env } from '../config/env';
import { localDate } from '../demo/demo-generators';
import { PrismaService } from '../prisma/prisma.service';
import {
  type SiteSettings,
  SiteSettingsService,
} from '../site-settings/site-settings.service';

const FIRST_NAME = 'retention-job-first';
const INTERVAL_NAME = 'retention-job';
const FIRST_PASS_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BATCH = 500;
/** Export files live this long after they are made. */
const EXPORT_DAYS = 7;
/** A download takes at most 2 minutes and a PDF call 1, so a `.part` this old belongs to no running job. */
const PART_STALE_MS = HOUR_MS;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `zv_<id>` and `zv_<id>_sub`, the MediaMTX paths the API creates; `feed_*` and the rest never match. */
const RECORDED = /^zv_([A-Za-z0-9_-]+?)(_sub)?$/;

type Counts = { deleted: number; failed: number; error?: string };

/**
 * Hourly clean-up of what the API's disks collect: snapshot folders past their age, kept clips past
 * the camera's evidence retention, export files, and the recordings of cameras that no longer
 * exist (MediaMTX only ages out paths it still has). Every pass is idempotent. Each sweep has its
 * own `try`, a failed delete is counted and the row or file stays for the next pass.
 */
@Injectable()
export class RetentionJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionJob.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly settings: SiteSettingsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (this.env.JOBS !== 'on') return;
    this.scheduler.addTimeout(
      FIRST_NAME,
      setTimeout(() => {
        void this.tick();
        this.scheduler.addInterval(
          INTERVAL_NAME,
          setInterval(() => void this.tick(), HOUR_MS),
        );
      }, FIRST_PASS_MS),
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('timeout', FIRST_NAME)) {
      this.scheduler.deleteTimeout(FIRST_NAME);
    }
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** One pass. Skipped while the previous pass runs; never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // `loaded()`, never `current`: while Postgres is down `current` holds the defaults, and a
      // delete job must not run on a shorter retention than the site chose.
      const s = await this.settings.loaded();
      await this.sweep('snapshots', () => this.snapshots(now, s));
      await this.sweep('kept clips', () => this.keptClips(now, s));
      await this.sweep('export files', () => this.exportFiles(now));
      await this.sweep('deleted cameras', () => this.deletedCameras(now, s));
    } catch (err) {
      this.log.warn(
        `retention skipped, site settings not loaded: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async sweep(name: string, run: () => Promise<Counts>): Promise<void> {
    try {
      const c = await run();
      if (c.deleted || c.failed) {
        this.log.log(
          `${name}: deleted ${c.deleted}, failed ${c.failed}${c.error ? ` (${c.error})` : ''}`,
        );
      }
    } catch (err) {
      this.log.warn(`${name} sweep failed: ${(err as Error).message}`);
    }
  }

  /** Snapshot folders before today − days, except the JPEGs of events that have an Evidence row. */
  private async snapshots(now: Date, s: SiteSettings): Promise<Counts> {
    const c: Counts = { deleted: 0, failed: 0 };
    const today = localDate(now.getTime(), s.timeZone);
    const audit = new Set(
      (
        await this.prisma.camera.findMany({
          where: { auditCamera: true },
          select: { id: true },
        })
      ).map((camera) => camera.id),
    );
    for (const camera of await dirs(this.env.SNAPSHOT_DIR)) {
      const days = audit.has(camera)
        ? s.auditSnapshotRetentionDays
        : s.snapshotRetentionDays;
      const cutoff = shiftDays(today, -days);
      for (const date of await dirs(join(this.env.SNAPSHOT_DIR, camera))) {
        if (!isRealDate(date) || date >= cutoff) continue;
        await this.snapshotFolder(join(this.env.SNAPSHOT_DIR, camera, date), c);
      }
    }
    return c;
  }

  private async snapshotFolder(folder: string, c: Counts): Promise<void> {
    try {
      const names = (await readdir(folder, { withFileTypes: true }))
        .filter((f) => f.isFile())
        .map((f) => f.name);
      const ids = names
        .filter((n) => n.endsWith('.jpg'))
        .map((n) => n.slice(0, -4));
      const protectedIds = new Set(
        ids.length === 0
          ? []
          : (
              await this.prisma.$queryRaw<{ eventId: string }[]>`
                SELECT "eventId" FROM "Evidence" WHERE "eventId" = ANY(${ids})`
            ).map((r) => r.eventId),
      );
      for (const name of names) {
        if (name.endsWith('.jpg') && protectedIds.has(name.slice(0, -4))) {
          continue;
        }
        if (await this.remove(join(folder, name), c)) c.deleted++;
      }
      await rmdir(folder).catch(() => undefined); // only an empty folder goes
    } catch (err) {
      this.fail(c, err);
    }
  }

  /**
   * Evidence rows (not the QUEUED ones: a pin may be writing that file right now) older than the
   * camera's evidence retention: the file, then the row. Orphan `.mp4.part` files go too.
   */
  private async keptClips(now: Date, s: SiteSettings): Promise<Counts> {
    const c: Counts = { deleted: 0, failed: 0 };
    let last = '';
    for (;;) {
      const rows = await this.prisma.$queryRaw<
        { eventId: string; filePath: string | null }[]
      >`
        SELECT e."eventId", e."filePath"
          FROM "Evidence" e LEFT JOIN "Camera" c ON c."id" = e."cameraId"
         WHERE e."status" <> 'QUEUED' AND e."eventId" > ${last}
           AND e."eventTime" < ${now}::timestamptz
               - make_interval(days => COALESCE(c."evidenceRetentionDays", ${s.evidenceRetentionDays}::int))
         ORDER BY e."eventId" LIMIT ${BATCH}`;
      if (rows.length === 0) break;
      last = rows[rows.length - 1].eventId;
      for (const { eventId, filePath } of rows) {
        if (filePath) {
          const full = inside(this.env.EVIDENCE_DIR, filePath);
          if (!full) {
            this.fail(c, new Error('a file path outside the evidence folder'));
            continue;
          }
          if (!(await this.remove(full, c))) continue;
          await rmdir(dirname(full)).catch(() => undefined);
        }
        const gone = await this.prisma.evidence.deleteMany({
          where: { eventId, status: { not: 'QUEUED' } },
        });
        c.deleted += gone.count;
      }
    }
    await this.partFiles(now, c);
    return c;
  }

  /** `<camera>/<date>/<event>.mp4.part` left by a crashed pin: the next attempt rewrites it anyway. */
  private async partFiles(now: Date, c: Counts): Promise<void> {
    const root = this.env.EVIDENCE_DIR;
    for (const camera of await dirs(root)) {
      for (const date of await dirs(join(root, camera))) {
        const folder = join(root, camera, date);
        try {
          for (const f of await readdir(folder, { withFileTypes: true })) {
            if (!f.isFile() || !f.name.endsWith('.mp4.part')) continue;
            const path = join(folder, f.name);
            if ((await stat(path)).mtimeMs > now.getTime() - PART_STALE_MS) {
              continue;
            }
            if (await this.remove(path, c)) c.deleted++;
          }
          await rmdir(folder).catch(() => undefined);
        } catch (err) {
          this.fail(c, err);
        }
      }
    }
  }

  private async exportFiles(now: Date): Promise<Counts> {
    const c: Counts = { deleted: 0, failed: 0 };
    const rows = await this.prisma.$queryRaw<
      { id: string; filePath: string | null }[]
    >`
      SELECT "id", "filePath" FROM "ExportJob"
       WHERE "status" = 'DONE'
         AND "finishedAt" < ${now}::timestamptz - make_interval(days => ${EXPORT_DAYS}::int)
       ORDER BY "finishedAt" LIMIT ${BATCH}`;
    for (const { id, filePath } of rows) {
      if (filePath) {
        const full = inside(this.env.EXPORTS_DIR, filePath);
        if (!full) {
          this.fail(c, new Error('a file path outside the exports folder'));
          continue;
        }
        if (!(await this.remove(full, c))) continue;
      }
      await this.prisma.exportJob.update({
        where: { id },
        data: { status: 'EXPIRED', filePath: null },
      });
      c.deleted++;
    }
    await this.exportParts(now, c);
    return c;
  }

  /** `<id>.pdf.part` left by a crashed PDF tick (the retry rewrites it); only regular files directly in EXPORTS_DIR. */
  private async exportParts(now: Date, c: Counts): Promise<void> {
    try {
      const root = this.env.EXPORTS_DIR;
      for (const f of await readdir(root, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.pdf.part')) continue;
        const path = join(root, f.name);
        if ((await stat(path)).mtimeMs > now.getTime() - PART_STALE_MS)
          continue;
        if (await this.remove(path, c)) c.deleted++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.fail(c, err);
    }
  }

  /** I6: `zv_<id>[_sub]` folders whose camera is gone: files past the recording retention, then the folder. */
  private async deletedCameras(now: Date, s: SiteSettings): Promise<Counts> {
    const c: Counts = { deleted: 0, failed: 0 };
    const known = new Set(
      (await this.prisma.camera.findMany({ select: { id: true } })).map(
        (camera) => camera.id,
      ),
    );
    const cutoff = now.getTime() - s.recordingRetentionDays * DAY_MS;
    for (const name of await dirs(this.env.RECORDINGS_DIR)) {
      const match = RECORDED.exec(name);
      if (!match || known.has(match[1])) continue;
      const folder = join(this.env.RECORDINGS_DIR, name);
      try {
        for (const f of await readdir(folder, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          const path = join(folder, f.name);
          if ((await stat(path)).mtimeMs >= cutoff) continue;
          if (await this.remove(path, c)) c.deleted++;
        }
        await rmdir(folder).catch(() => undefined);
      } catch (err) {
        this.fail(c, err);
      }
    }
    return c;
  }

  /** ENOENT counts as gone; any other error (EACCES on a folder MediaMTX made) is counted and kept for the next pass. */
  private async remove(path: string, c: Counts): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      this.fail(c, err);
      return false;
    }
  }

  private fail(c: Counts, err: unknown): void {
    c.failed++;
    c.error ??= (err as Error).message; // one message per sweep, not one line per file
  }
}

/** Sub-folder names of `path`; a folder that does not exist yet has none. Symlinks are not followed. */
async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** `root/rel`, or null when `rel` would leave `root`. */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full.startsWith(resolve(root) + sep) ? full : null;
}

function isRealDate(name: string): boolean {
  return (
    DATE.test(name) &&
    new Date(`${name}T00:00:00Z`).toISOString().startsWith(name)
  );
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
