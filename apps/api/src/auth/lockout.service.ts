import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_WINDOW_SEC = 15 * 60;

const key = (username: string) => `loginfail:${username.toLowerCase()}`;

/** 5 failed logins within 15 minutes lock the username until the counter expires. */
@Injectable()
export class LockoutService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Seconds left on the lock, 0 when not locked. */
  async lockedForSec(username: string): Promise<number> {
    const count = Number(await this.redis.get(key(username)));
    if (count < LOCKOUT_FAILURES) return 0;
    const ttl = await this.redis.ttl(key(username));
    return ttl > 0 ? ttl : LOCKOUT_WINDOW_SEC;
  }

  /** Counts a failure; the 15 minute window starts at the first one. */
  async recordFailure(username: string): Promise<void> {
    await this.redis
      .multi()
      .incr(key(username))
      .expire(key(username), LOCKOUT_WINDOW_SEC, 'NX')
      .exec();
  }

  async reset(username: string): Promise<void> {
    await this.redis.del(key(username));
  }
}
