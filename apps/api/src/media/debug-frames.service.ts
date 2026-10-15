import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.constants';
import { RedisPubSub } from '../redis/pubsub';

interface CameraWatch {
  viewers: Set<(jpeg: Buffer) => void>;
  timer: NodeJS.Timeout | null;
  releaseSub: (() => Promise<void>) | null;
  subPromise: Promise<() => Promise<void>> | null;
}

@Injectable()
export class DebugFramesService implements OnApplicationShutdown {
  private readonly logger = new Logger(DebugFramesService.name);
  private readonly watches = new Map<string, CameraWatch>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly pubsub: RedisPubSub,
  ) {}

  async watch(
    cameraId: string,
    onFrame: (jpeg: Buffer) => void,
  ): Promise<() => void> {
    let watch = this.watches.get(cameraId);
    if (!watch) {
      watch = {
        viewers: new Set(),
        timer: null,
        releaseSub: null,
        subPromise: null,
      };
      this.watches.set(cameraId, watch);
    }

    watch.viewers.add(onFrame);

    if (watch.viewers.size === 1) {
      let lastWarn = 0;
      const refreshKey = () => {
        this.redis
          .set(`cam:${cameraId}:debug`, 1, 'EX', 5)
          .catch((err: Error) => {
            const now = Date.now();
            if (now - lastWarn >= 60_000) {
              lastWarn = now;
              this.logger.warn(
                `Failed to refresh debug key for ${cameraId}: ${err.message}`,
              );
            }
          });
      };
      refreshKey();
      watch.timer = setInterval(refreshKey, 2000);
      watch.timer.unref();

      const channel = `cam:${cameraId}:debugframes`;
      const dispatch = (data: Buffer) => {
        const current = this.watches.get(cameraId);
        if (current) {
          for (const viewer of current.viewers) {
            try {
              viewer(data);
            } catch (err) {
              this.logger.error(
                `Error dispatching debug frame to viewer: ${(err as Error).message}`,
              );
            }
          }
        }
      };

      const subPromise = this.pubsub.subscribe(channel, dispatch);
      watch.subPromise = subPromise;

      try {
        const release = await subPromise;
        watch.releaseSub = release;
      } catch (err) {
        if (watch.timer) {
          clearInterval(watch.timer);
          watch.timer = null;
        }
        this.watches.delete(cameraId);
        throw err;
      }
    } else if (watch.subPromise) {
      // Multiple viewers joining while first subscription is in flight
      await watch.subPromise;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.watches.get(cameraId);
      if (!current) return;

      current.viewers.delete(onFrame);
      if (current.viewers.size === 0) {
        if (current.timer) {
          clearInterval(current.timer);
          current.timer = null;
        }
        this.watches.delete(cameraId);
        if (current.releaseSub) {
          void current.releaseSub();
        }
      }
    };
  }

  async onApplicationShutdown(): Promise<void> {
    for (const watch of this.watches.values()) {
      if (watch.timer) {
        clearInterval(watch.timer);
      }
      if (watch.releaseSub) {
        await watch.releaseSub().catch(() => undefined);
      }
    }
    this.watches.clear();
  }
}
