import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export const CFG_CHANGED_CHANNEL = 'cfg:changed';

/** Tells the engines that a camera's config changed. `version` is null when it was deleted. */
@Injectable()
export class ConfigNotifier {
  private readonly logger = new Logger(ConfigNotifier.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Call after the database transaction committed. A failure is logged, never thrown. */
  async notify(cameraId: string, version: number | null): Promise<void> {
    try {
      await this.redis.publish(
        CFG_CHANGED_CHANNEL,
        JSON.stringify({ cameraId, version }),
      );
    } catch (err) {
      this.logger.warn(
        `cfg:changed for ${cameraId} not published: ${(err as Error).message}`,
      );
    }
  }
}
