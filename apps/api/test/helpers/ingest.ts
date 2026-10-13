import type Redis from 'ioredis';
import { ownerQuery } from '../setup/db';

/** Polls `probe` every 50 ms until it returns a truthy value; throws after 10 s. */
export async function waitFor<T>(
  probe: () => Promise<T | false | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Waits until group `api` has read and acked every entry of `events`. */
export const drained = (redis: Redis) =>
  waitFor(async () => {
    const groups = (await redis
      .xinfo('GROUPS', 'events')
      .catch(() => [])) as unknown[][];
    const api = groups
      .map((flat) => {
        const info: Record<string, unknown> = {};
        for (let i = 0; i < flat.length; i += 2) {
          info[flat[i] as string] = flat[i + 1];
        }
        return info;
      })
      .find((g) => g.name === 'api');
    return api?.lag === 0 && api.pending === 0;
  }, 'the api group to drain the stream');

/** Entries group `api` has read but not acked. */
export const pendingCount = async (redis: Redis) =>
  ((await redis.xpending('events', 'api')) as [number])[0];

/** Row count of `table`, read as zoo_owner. */
export const count = async (table: string) =>
  Number(
    (
      (await ownerQuery(`SELECT count(*) AS n FROM "${table}"`)) as {
        n: string;
      }[]
    )[0].n,
  );

/** Inserts a FILE camera so events for it pass the camera check. */
export async function seedCamera(
  id: string,
  engineGroup: string,
): Promise<void> {
  await ownerQuery(
    `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "engineGroup", "activeVersion", "updatedAt")
     VALUES ($1, $1, 'cashier_presence', 'FILE', 'enc', $2, 1, now())`,
    id,
    engineGroup,
  );
}
