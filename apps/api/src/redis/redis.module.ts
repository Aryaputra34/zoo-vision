import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

/**
 * Injection token for the shared ioredis client, for ordinary commands. Anything that blocks
 * (XREADGROUP BLOCK, SUBSCRIBE) must use its own `redis.duplicate()`, give it an `error`
 * listener and close it itself.
 */
export const REDIS = Symbol('REDIS');

const logger = new Logger('Redis');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => {
        const redis = new Redis(env.REDIS_URL);
        // Without a listener ioredis prints every failed reconnect as an "Unhandled error event".
        redis.on('error', (err: Error) => logger.warn(err.message));
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // While Redis is unreachable, QUIT would wait behind the commands queued offline.
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
