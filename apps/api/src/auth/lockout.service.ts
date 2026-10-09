import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_WINDOW_SEC = 15 * 60;

const key = (username: string) => `loginfail:${username.toLowerCase()}`;

/** Converts a PTTL answer (-2 missing, -1 no expiry) into whole seconds left on the window. */
const secLeft = (pttl: number) =>
  pttl > 0 ? Math.ceil(pttl / 1000) : LOCKOUT_WINDOW_SEC;

/** 5 failed logins within 15 minutes lock the username until the counter expires. */
@Injectable()
export class LockoutService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Seconds left on the lock, 0 when not locked. Count and TTL are read in one MULTI. */
  async lockedForSec(username: string): Promise<number> {
    const results = await this.redis
      .multi()
      .get(key(username))
      .pttl(key(username))
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const pttl = Number(results?.[1]?.[1] ?? -2);
    return count > LOCKOUT_FAILURES - 1 && pttl !== -2 ? secLeft(pttl) : 0;
  }

  /** Counts a failure; the 15 minute window starts at the first one. */
  async recordFailure(username: string): Promise<void> {
    await this.reserve(username);
  }

  /**
   * Takes one of the 5 attempts atomically before the password is checked, so concurrent
   * requests cannot all pass a check-then-act race. Returns 0 when the attempt may go ahead,
   * else the seconds left on the lock. A refused attempt does not extend the window.
   */
  async reserve(username: string): Promise<number> {
    const results = await this.redis
      .multi()
      .incr(key(username))
      .expire(key(username), LOCKOUT_WINDOW_SEC, 'NX')
      .pttl(key(username))
      .exec();
    const n = Number(results?.[0]?.[1]);
    const pttl = Number(results?.[2]?.[1]);
    return n > LOCKOUT_FAILURES ? secLeft(pttl) : 0;
  }

  async reset(username: string): Promise<void> {
    await this.redis.del(key(username));
  }
}
