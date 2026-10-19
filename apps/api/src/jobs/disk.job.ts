import { randomBytes } from 'node:crypto';
import { stat, statfs } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import { LiveGateway } from '../live/live.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { type Level, nextLevel } from './disk-levels';

const INTERVAL_NAME = 'disk-job';
const TICK_MS = 5 * 60_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Warns before a disk fills: a `disk_low` system event and a `disk.warning` message for the
 * managers when a disk crosses 85% (warning) or 95% (critical). Warnings only; MediaMTX still
 * deletes recordings by age. The level per disk lives in memory, so after a restart a disk that is
 * still full warns once more.
 */
@Injectable()
export class DiskJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DiskJob.name);
  private running = false;
  private readonly levels = new Map<number, Level>();
  private readonly logged = new Set<number>();
  private readonly missing = new Set<string>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly gateway: LiveGateway,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (this.env.JOBS !== 'on') return;
    this.scheduler.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), TICK_MS),
    );
    void this.tick(); // the first pass logs every disk once
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** One reading of every disk. Skipped while the previous pass runs; never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const seen = new Set<number>();
      const { RECORDINGS_DIR, SNAPSHOT_DIR, EVIDENCE_DIR, EXPORTS_DIR } =
        this.env;
      for (const path of [
        RECORDINGS_DIR,
        SNAPSHOT_DIR,
        EVIDENCE_DIR,
        EXPORTS_DIR,
      ]) {
        await this.check(path, seen).catch((err: Error) =>
          this.log.warn(`disk check of ${path} failed: ${err.message}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** One disk is read once, through the first of the four paths that sits on it. */
  private async check(path: string, seen: Set<number>): Promise<void> {
    let dev: number;
    try {
      dev = (await stat(path)).dev;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!this.missing.has(path)) {
        this.missing.add(path);
        this.log.warn(`${path} does not exist; its disk is not checked`);
      }
      return;
    }
    if (seen.has(dev)) return;
    seen.add(dev);

    const fs = await statfs(path);
    const used = fs.blocks - fs.bfree;
    const usedPercent =
      used + fs.bavail > 0 ? round1((used / (used + fs.bavail)) * 100) : 0;
    const freeBytes = Math.round(fs.bavail * fs.bsize);
    if (!this.logged.has(dev)) {
      this.logged.add(dev);
      this.log.log(
        `disk of ${path}: ${usedPercent}% used, ${round1(freeBytes / 1e9)} GB free`,
      );
    }

    const { level, crossed } = nextLevel(
      this.levels.get(dev) ?? 'ok',
      usedPercent,
    );
    if (crossed) {
      const data = { path, usedPercent, freeBytes };
      const time = new Date();
      await this.prisma.event.create({
        data: {
          id: `evt_${randomBytes(16).toString('hex')}`,
          time,
          cameraId: null,
          useCase: 'system',
          type: 'disk_low',
          severity: crossed,
          configVersion: null,
          schemaVersion:
            this.contracts.registry.useCases.get('system')?.schemaVersion ?? 1,
          data,
        },
      });
      this.gateway.toManagers('disk.warning', {
        ...data,
        severity: crossed,
        time: time.toISOString(),
      });
    }
    // after the event is written: a failed insert is retried at the next tick, not lost
    this.levels.set(dev, level);
  }
}
