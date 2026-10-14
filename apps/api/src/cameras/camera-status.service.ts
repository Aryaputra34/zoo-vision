import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import type { CameraStatusDto } from './dto/camera-status.dto';

/** What the engine publishes in the hash `cam:{id}:status`, parsed. */
export type CameraStatus = CameraStatusDto;

export const statusKey = (id: string) => `cam:${id}:status`;
export const frameKey = (id: string) => `cam:${id}:frame`;

const num = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (value: string | undefined): number | null =>
  value === undefined || value === '' ? null : num(value);

function parseLive(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parses a status hash, or returns null for a missing key (HGETALL gives {}). */
function parseStatus(hash: Record<string, string>): CameraStatus | null {
  if (Object.keys(hash).length === 0) return null;
  return {
    state: hash.state ?? 'starting',
    fps: num(hash.fps),
    lastFrameAt: numOrNull(hash.lastFrameAt),
    appliedVersion: numOrNull(hash.appliedVersion),
    configError: hash.configError ? hash.configError : null,
    restarts: num(hash.restarts),
    live: parseLive(hash.live),
    updatedAt: num(hash.updatedAt),
  };
}

@Injectable()
export class CameraStatusService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** The status of each camera id; null when its key is missing (the camera is offline). */
  async read(ids: string[]): Promise<Map<string, CameraStatus | null>> {
    const result = new Map<string, CameraStatus | null>();
    if (ids.length === 0) return result;
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(statusKey(id));
    const replies = (await pipeline.exec()) ?? [];
    ids.forEach((id, i) => {
      const [err, hash] = replies[i] ?? [new Error('no reply'), null];
      if (err) throw err;
      result.set(id, parseStatus(hash as Record<string, string>));
    });
    return result;
  }

  /** The latest JPEG of a camera, or null. */
  frame(id: string): Promise<Buffer | null> {
    return this.redis.getBuffer(frameKey(id));
  }
}
