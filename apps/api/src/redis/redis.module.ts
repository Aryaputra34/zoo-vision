import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

import { RedisPubSub } from './pubsub';

import { REDIS } from './redis.constants';
export { REDIS } from './redis.constants';

const logger = new Logger('Redis');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => {
        // A dead Redis must fail a request in seconds, not hang it: queued commands give up after
        // 2 reconnect attempts, and a command that gets no answer times out after 5 s.
        const redis = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 2,
          commandTimeout: 5000,
        });
        // Without a listener ioredis prints every failed reconnect as an "Unhandled error event".
        redis.on('error', (err: Error) => logger.warn(err.message));
        return redis;
      },
    },
    RedisPubSub,
  ],
  exports: [REDIS, RedisPubSub],
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
