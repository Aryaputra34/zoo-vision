import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import Redis from 'ioredis';
import { statusKey } from '../cameras/camera-status.service';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const INTERVAL_NAME = 'offline-job';
const TICK_MS = 5000;

/**
 * Turns a missing `cam:{id}:status` key into an open `camera_offline` interval (useCase `system`)
 * and closes it again when the key returns or the camera is disabled. The partial unique index
 * `Interval_open_camera_offline` allows one open interval per camera.
 */
@Injectable()
export class OfflineJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OfflineJob.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly contracts: ContractsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (this.env.JOBS !== 'on') return;
    const timer = setInterval(() => void this.tick(), TICK_MS);
    this.scheduler.addInterval(INTERVAL_NAME, timer);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** One pass over every camera. Skipped while the previous pass still runs; never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run(now);
    } catch (err) {
      this.logger.warn(`offline check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async run(now: Date): Promise<void> {
    const cameras = await this.prisma.camera.findMany({
      select: { id: true, enabled: true },
    });
    const openRows = await this.prisma.$queryRaw<{ cameraId: string }[]>`
      SELECT "cameraId" FROM "Interval"
       WHERE "useCase" = 'system' AND "kind" = 'camera_offline' AND "end" IS NULL`;
    const open = new Set(openRows.map((r) => r.cameraId));
    const present = await this.keysPresent(cameras.map((c) => c.id));

    const toOpen: string[] = [];
    const toClose: { id: string; reason: 'online' | 'disabled' }[] = [];
    for (const { id, enabled } of cameras) {
      if (!enabled) {
        if (open.has(id)) toClose.push({ id, reason: 'disabled' });
      } else if (present.has(id)) {
        if (open.has(id)) toClose.push({ id, reason: 'online' });
      } else if (!open.has(id)) {
        toOpen.push(id);
      }
    }

    for (const { id, reason } of toClose) {
      await this.prisma.$executeRaw`
        UPDATE "Interval" SET "end" = ${now}::timestamptz, "endReason" = ${reason}
         WHERE "cameraId" = ${id} AND "useCase" = 'system' AND "kind" = 'camera_offline'
           AND "end" IS NULL`;
    }
    if (toOpen.length === 0) return;
    const schemaVersion =
      this.contracts.registry.useCases.get('system')?.schemaVersion;
    if (schemaVersion === undefined) {
      throw new Error('the system contract is not loaded');
    }
    for (const id of toOpen) {
      const intervalId = `ses_${randomBytes(16).toString('hex')}`;
      await this.prisma.$executeRaw`
        INSERT INTO "Interval" ("id", "cameraId", "useCase", "kind", "subjectId", "start",
                                "configVersion", "schemaVersion", "data")
        VALUES (${intervalId}, ${id}, 'system', 'camera_offline', NULL, ${now}::timestamptz,
                NULL, ${schemaVersion}::int, '{}'::jsonb)
        ON CONFLICT ("cameraId")
          WHERE "useCase" = 'system' AND "kind" = 'camera_offline' AND "end" IS NULL
        DO NOTHING`;
    }
  }

  /** The ids whose status key exists. Throws on any Redis error, so a Redis outage opens nothing. */
  private async keysPresent(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.exists(statusKey(id));
    const replies = (await pipeline.exec()) ?? [];
    const present = new Set<string>();
    ids.forEach((id, i) => {
      const [err, exists] = replies[i] ?? [new Error('no reply'), 0];
      if (err) throw err;
      if (exists === 1) present.add(id);
    });
    return present;
  }
}
