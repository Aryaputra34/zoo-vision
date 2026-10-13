import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { sha256hex } from './hash';
import { SESSION_IDLE_MS, SESSION_MAX_MS, sessionTtlMs } from './session-ttl';

const sessKey = (hash: string) => `sess:${hash}`;
const userKey = (userId: string) => `usess:${userId}`;

/** Cookie sessions in Redis. Only the SHA-256 of a token is ever stored. */
@Injectable()
export class SessionService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Starts a session and returns the raw token (32 random bytes, base64url). */
  async create(
    userId: string,
    // Not stored: the session holds only the user id (the user is re-read on every request).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _meta: { ip?: string; userAgent?: string },
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const hash = sha256hex(token);
    await this.redis
      .multi()
      .set(
        sessKey(hash),
        JSON.stringify({ userId, createdAt: Date.now() }),
        'PX',
        SESSION_IDLE_MS,
      )
      .sadd(userKey(userId), hash)
      .pexpire(userKey(userId), SESSION_MAX_MS)
      .exec();
    return token;
  }

  /** The session's user, sliding its expiry; null when unknown or past its 7 days. */
  async resolve(token: string): Promise<{ userId: string } | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) {
      return null;
    }
    const hash = sha256hex(token);
    const raw = await this.redis.get(sessKey(hash));
    if (!raw) return null;
    const { userId, createdAt } = JSON.parse(raw) as {
      userId: string;
      createdAt: number;
    };
    const ttl = sessionTtlMs(createdAt, Date.now());
    if (ttl <= 0) {
      await this.remove(hash, userId);
      return null;
    }
    await this.redis.pexpire(sessKey(hash), ttl);
    return { userId };
  }

  async destroy(token: string): Promise<void> {
    const hash = sha256hex(token);
    const raw = await this.redis.get(sessKey(hash));
    if (!raw) return;
    await this.remove(hash, (JSON.parse(raw) as { userId: string }).userId);
  }

  /** Ends all of a user's sessions, except the one for `exceptToken`. */
  async revokeAllForUser(userId: string, exceptToken?: string): Promise<void> {
    const keep = exceptToken ? sha256hex(exceptToken) : undefined;
    const hashes = (await this.redis.smembers(userKey(userId))).filter(
      (h) => h !== keep,
    );
    if (hashes.length === 0) return;
    await this.redis
      .multi()
      .del(...hashes.map(sessKey))
      .srem(userKey(userId), ...hashes)
      .exec();
  }

  private async remove(hash: string, userId: string): Promise<void> {
    await this.redis
      .multi()
      .del(sessKey(hash))
      .srem(userKey(userId), hash)
      .exec();
  }
}
