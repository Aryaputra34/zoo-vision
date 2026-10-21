import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
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
import { PlaybackService } from '../media/playback.service';
import { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from '../site-settings/site-settings.service';
import { isSafeId } from './safe-id';

const INTERVAL_NAME = 'pin-job';
const TICK_MS = 10_000;
const BATCH = 5;
/** The whole download of one clip, from the request to the last byte. */
const DOWNLOAD_MS = 120_000;
/** Failures after which a clip is given up on: 8 retries at 1 … 128 minutes, about 4 hours. */
const MAX_ATTEMPTS = 9;

type Due = {
  eventId: string;
  cameraId: string;
  eventTime: Date;
  attempts: number;
};

/**
 * Copies the clip of every due `Evidence` row from MediaMTX playback into EVIDENCE_DIR, so it
 * outlives the continuous recording. A crash mid-copy leaves the row `QUEUED`; the next attempt
 * overwrites the `.part` file.
 */
@Injectable()
export class PinJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PinJob.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly playback: PlaybackService,
    private readonly settings: SiteSettingsService,
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

  /** One pass over the due rows, one after another. Skipped while the previous pass runs; never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.$queryRaw<Due[]>`
        SELECT "eventId", "cameraId", "eventTime", "attempts" FROM "Evidence"
         WHERE "status" = 'QUEUED' AND "runAt" <= ${now}::timestamptz
         ORDER BY "runAt" LIMIT ${BATCH}`;
      for (const row of due) await this.pin(row, now);
    } catch (err) {
      this.log.warn(`pin tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async pin(row: Due, now: Date): Promise<void> {
    const { eventId, cameraId } = row;
    try {
      // both become file names below
      if (!isSafeId(cameraId) || !isSafeId(eventId)) {
        return this.settle(eventId, { status: 'FAILED', error: 'invalid id' });
      }
      const camera = await this.prisma.camera.findUnique({
        where: { id: cameraId },
        select: {
          sourceType: true,
          subStreamUrlEnc: true,
          recordingEnabled: true,
          recordingStream: true,
          inferenceStream: true,
          clipBeforeSec: true,
          clipAfterSec: true,
        },
      });
      if (!camera) return this.settle(eventId, { status: 'NO_RECORDING' });

      const clip = await this.playback.open(
        { ...camera, id: cameraId },
        row.eventTime,
        AbortSignal.timeout(DOWNLOAD_MS),
      );
      if (!clip.ok && clip.reason !== 'UNAVAILABLE') {
        return this.settle(eventId, { status: 'NO_RECORDING' });
      }
      const stored = clip.ok ? await this.store(row, clip.body) : null;
      if (stored) {
        return this.settle(eventId, {
          status: 'KEPT',
          filePath: stored.filePath,
          sizeBytes: stored.sizeBytes,
          error: null,
        });
      }
      await this.retry(row, now);
    } catch (err) {
      // the folder, the disk or Postgres: not the clip's fault, so it is tried again
      this.log.warn(`pin of ${eventId} failed: ${(err as Error).message}`);
      await this.retry(row, now).catch(() => undefined);
    }
  }

  /** Streams the clip into `<camera>/<date>/<event>.mp4.part`, then renames it. Null: the stream broke. */
  private async store(
    row: Due,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ filePath: string; sizeBytes: number } | null> {
    const date = localDate(row.eventTime.getTime(), this.settings.timeZone);
    const filePath = `${row.cameraId}/${date}/${row.eventId}.mp4`;
    const target = join(this.env.EVIDENCE_DIR, filePath);
    await mkdir(join(this.env.EVIDENCE_DIR, row.cameraId, date), {
      recursive: true,
    });
    try {
      await pipeline(
        Readable.fromWeb(body as WebReadableStream<Uint8Array>),
        createWriteStream(`${target}.part`),
      );
    } catch {
      // playback died mid-clip, or the deadline passed: never keep half a clip
      await rm(`${target}.part`, { force: true });
      return null;
    }
    await rename(`${target}.part`, target);
    return { filePath, sizeBytes: (await stat(target)).size };
  }

  /** A failed attempt: wait 1, 2, 4 … 128 minutes, and give up at the 9th failure. */
  private async retry(row: Due, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      return this.settle(row.eventId, {
        status: 'FAILED',
        attempts,
        error: 'recording service unavailable',
      });
    }
    await this.settle(row.eventId, {
      attempts,
      runAt: new Date(now.getTime() + 2 ** (attempts - 1) * 60_000),
    });
  }

  private async settle(
    eventId: string,
    data: {
      status?: 'KEPT' | 'NO_RECORDING' | 'FAILED';
      attempts?: number;
      runAt?: Date;
      error?: string | null;
      filePath?: string;
      sizeBytes?: number;
    },
  ): Promise<void> {
    await this.prisma.evidence.update({ where: { eventId }, data });
  }
}
