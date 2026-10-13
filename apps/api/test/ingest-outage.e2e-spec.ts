import { INestApplication, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { App } from 'supertest/types';
import { createTestApp } from './app';
import {
  count,
  drained as drainedOf,
  pendingCount as pendingOf,
  seedCamera,
  waitFor,
} from './helpers/ingest';
import { closeMsg, eventMsg, openMsg, xadd } from './helpers/messages';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

describe('ingest: entries survive a database outage exactly once', () => {
  let apps: INestApplication<App>[] = [];
  let redis: Redis;
  let error: jest.SpyInstance;

  const drained = () => drainedOf(redis);
  const pendingCount = () => pendingOf(redis);
  const ingestFailures = () =>
    error.mock.calls.filter(([m]) => String(m).startsWith('ingest failed'))
      .length;

  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    await seedCamera('cam_a', 'default');
    redis = new Redis(process.env.REDIS_URL as string);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
    await redis.quit();
    error.mockRestore();
  });

  const start = async (env: Record<string, string> = {}) => {
    const app = await createTestApp({ INGEST: 'on', ...env });
    apps.push(app);
    return app;
  };

  it('entries read while Postgres is unreachable land exactly once after recovery', async () => {
    const unreachable = new URL(process.env.DATABASE_URL as string);
    unreachable.port = '1';

    const events = [eventMsg(), eventMsg(), eventMsg()];
    const open = openMsg();
    const close = closeMsg({ sessionId: open.sessionId });
    const messages = [...events, open, close];
    // XADDed before the consumer starts, so one read takes all five: while an entry is pending,
    // the consumer re-reads only its pending list and never reaches the '>' read, so entries
    // XADDed after its first read stay unread until the database is back
    for (const msg of messages) await xadd(msg);
    const appA = await start({ DATABASE_URL: unreachable.toString() });

    await waitFor(
      async () =>
        ingestFailures() > 0 && (await pendingCount().catch(() => 0)) === 5, // NOGROUP until the group exists
      'five pending entries and a logged ingest failure',
    );
    // transient errors must not count towards dead-lettering: checked while the database fails
    expect(await redis.hlen('ingest:failures')).toBe(0);
    await appA.close();
    apps = apps.filter((app) => app !== appA);

    await start();
    await drained();

    const stored = (await ownerQuery(
      `SELECT "id" FROM "Event" ORDER BY "id"`,
    )) as { id: string }[];
    expect(stored.map((r) => r.id)).toEqual(
      events.map((e) => e.id as string).sort(),
    );
    expect(
      await ownerQuery(
        `SELECT "id", "endReason" FROM "Interval" WHERE "id" = $1`,
        open.sessionId,
      ),
    ).toEqual([{ id: open.sessionId, endReason: 'ended' }]);
    expect(await count('DeadEvent')).toBe(0);
    expect(await redis.hlen('ingest:failures')).toBe(0);

    for (const msg of messages) await xadd(msg);
    await drained();

    expect(await count('Event')).toBe(3);
    expect(await count('Interval')).toBe(1);
    expect(await count('DeadEvent')).toBe(0);
  });

  it('a revoked grant holds entries until the grant is back, then they land once', async () => {
    await ownerQuery('REVOKE INSERT ON "Event" FROM zoo_api');
    try {
      const events = [eventMsg(), eventMsg()];
      for (const msg of events) await xadd(msg); // before the consumer starts: one read takes both
      await start();

      await waitFor(
        () => Promise.resolve(ingestFailures() > 0),
        'a logged ingest failure',
      );
      expect(await pendingCount()).toBe(2);
      expect(await redis.hlen('ingest:failures')).toBe(0);
      expect(await count('DeadEvent')).toBe(0);
      expect(await count('Event')).toBe(0);

      await ownerQuery('GRANT INSERT ON "Event" TO zoo_api');
      await drained();

      const stored = (await ownerQuery(
        `SELECT "id" FROM "Event" ORDER BY "id"`,
      )) as { id: string }[];
      expect(stored.map((r) => r.id)).toEqual(
        events.map((e) => e.id as string).sort(),
      );
      expect(await count('DeadEvent')).toBe(0);
    } finally {
      // TRUNCATE between tests does not restore grants
      await ownerQuery('GRANT INSERT ON "Event" TO zoo_api');
    }
  });
});
