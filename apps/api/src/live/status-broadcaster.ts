import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CameraStatusService } from '../cameras/camera-status.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiveGateway } from './live.gateway';

const TICK_MS = 2000;
const IDS_TTL_MS = 10_000;
const WARN_EVERY_MS = 60_000;

/**
 * While anyone is in the `status` room, sends `status.snapshot {at, cameras}` every 2 s: the
 * status of every camera, null for one that is offline. The status comes from Redis, so it keeps
 * flowing while Postgres is down (the camera ids are cached 10 s and then reused).
 */
@Injectable()
export class StatusBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StatusBroadcaster.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private ids: { at: number; list: string[] } | null = null;
  private warnedAt = 0;

  constructor(
    private readonly gateway: LiveGateway,
    private readonly statuses: CameraStatusService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick; public for tests. A failure skips the tick and is logged at most once a minute. */
  async tick(): Promise<void> {
    const room = this.gateway.server?.sockets.adapter.rooms.get('status');
    // a slow Redis must not stack ticks up
    if (!room || room.size === 0 || this.busy) return;
    this.busy = true;
    try {
      const statuses = await this.statuses.read(await this.cameraIds());
      this.gateway.server.to('status').emit('status.snapshot', {
        at: new Date().toISOString(),
        cameras: Object.fromEntries(statuses),
      });
    } catch (err) {
      if (Date.now() - this.warnedAt >= WARN_EVERY_MS) {
        this.warnedAt = Date.now();
        this.log.warn(
          `status tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private async cameraIds(): Promise<string[]> {
    if (this.ids && Date.now() - this.ids.at < IDS_TTL_MS) return this.ids.list;
    try {
      const cameras = await this.prisma.camera.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      this.ids = { at: Date.now(), list: cameras.map((c) => c.id) };
    } catch (err) {
      if (!this.ids) throw err; // nothing cached to fall back on
      this.ids.at = Date.now() - IDS_TTL_MS + 2000; // try again in 2 s, send the old list meanwhile
    }
    return this.ids.list;
  }
}
