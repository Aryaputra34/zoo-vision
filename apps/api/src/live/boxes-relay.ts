import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { RedisPubSub } from '../redis/pubsub';
import { LiveGateway } from './live.gateway';

interface RoomSubscription {
  release: (() => Promise<void>) | null;
  subPromise: Promise<void> | null;
  cancelled: boolean;
}

@Injectable()
export class BoxesRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BoxesRelay.name);
  private readonly subscriptions = new Map<string, RoomSubscription>();
  private readonly lastEmit = new Map<string, number>();
  private lastParseErrorLog = 0;

  constructor(
    private readonly gateway: LiveGateway,
    private readonly pubsub: RedisPubSub,
  ) {}

  onApplicationBootstrap(): void {
    const adapter = this.gateway.server.of('/').adapter;
    adapter.on('create-room', (room: string) => this.onCreateRoom(room));
    adapter.on('delete-room', (room: string) => this.onDeleteRoom(room));
  }

  private onCreateRoom(room: string): void {
    if (!room.startsWith('camera:')) return;
    const cameraId = room.slice('camera:'.length);
    const channel = `cam:${cameraId}:boxes`;

    if (this.subscriptions.has(room)) return;

    const sub: RoomSubscription = {
      release: null,
      subPromise: null,
      cancelled: false,
    };
    this.subscriptions.set(room, sub);

    sub.subPromise = this.pubsub
      .subscribe(channel, (data: Buffer) => {
        this.handleBoxes(room, cameraId, data);
      })
      .then(
        (release) => {
          sub.release = release;
          if (sub.cancelled) {
            // Room was closed/deleted while subscribe was in flight
            void release();
          }
        },
        (err) => {
          this.logger.warn(
            `Failed to subscribe to ${channel}: ${(err as Error).message}`,
          );
          this.subscriptions.delete(room);
        },
      );
  }

  private onDeleteRoom(room: string): void {
    if (!room.startsWith('camera:')) return;
    const sub = this.subscriptions.get(room);
    if (!sub) return;

    sub.cancelled = true;
    this.subscriptions.delete(room);

    if (sub.release) {
      void sub.release();
    }
  }

  private handleBoxes(room: string, cameraId: string, data: Buffer): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch (err) {
      const now = Date.now();
      if (now - this.lastParseErrorLog >= 60_000) {
        this.lastParseErrorLog = now;
        this.logger.warn(
          `Failed to parse boxes JSON for ${cameraId}: ${(err as Error).message}`,
        );
      }
      return;
    }

    const now = Date.now();
    const last = this.lastEmit.get(cameraId) ?? 0;
    // drop if < 100 ms after the camera's last emit
    if (now - last < 100) {
      return;
    }
    this.lastEmit.set(cameraId, now);

    this.gateway.server.to(room).emit('boxes', {
      ...payload,
      sentAt: now,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      sub.cancelled = true;
      if (sub.release) {
        await sub.release().catch(() => undefined);
      }
    }
    this.subscriptions.clear();
    this.lastEmit.clear();
  }
}
