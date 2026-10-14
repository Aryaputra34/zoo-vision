import { INestApplication, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { App } from 'supertest/types';
import { io, type Socket } from 'socket.io-client';
import { ContractsService } from '../src/contracts/contracts.service';
import { IngestService, type StreamEntry } from '../src/ingest/ingest.service';
import { LiveGateway } from '../src/live/live.gateway';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { createTestApp, listenTestApp } from './app';
import { asRole } from './helpers/auth';
import {
  closeMsg,
  eventMsg,
  metricMsg,
  type Msg,
  openMsg,
  xadd,
} from './helpers/messages';
import { count, seedCamera, waitFor } from './helpers/ingest';
import { flushRedis, ownerQuery, resetDb } from './setup/db';

type Received = { name: string; payload: Record<string, unknown>; at: number };

describe('post-commit push: event.created and data.changed', () => {
  let app: INestApplication<App>;
  let base: string;
  let redis: Redis;
  let ingest: IngestService;
  let gateway: LiveGateway;
  let socket: Socket;
  let received: Received[];
  let warn: jest.SpyInstance;

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const entries = (msgs: Msg[]): StreamEntry[] =>
    msgs.map((m, i) => ({ id: `${Date.now()}-${i}`, msg: JSON.stringify(m) }));
  const named = (name: string) => received.filter((m) => m.name === name);
  const eventsOf = (n: number, over: Msg = {}) =>
    Array.from({ length: n }, () => eventMsg(over));

  beforeAll(async () => {
    await resetDb();
    await flushRedis();
    await seedCamera('cam_a', 'default');
    await seedCamera('cam_b', 'default');
    // INGEST on: the consumer reads the stream; the direct processBatch calls below do not
    // need it but the first test goes through it
    app = await createTestApp({ INGEST: 'on' });
    base = await listenTestApp(app);
    redis = app.get<Redis>(REDIS);
    ingest = app.get(IngestService);
    gateway = app.get(LiveGateway);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { cookie } = await asRole(app, 'USER');
    socket = io(base, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    for (const name of ['event.created', 'data.changed']) {
      socket.on(name, (payload: Record<string, unknown>) =>
        received.push({ name, payload, at: Date.now() }),
      );
    }
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  });

  beforeEach(async () => {
    received = [];
    // let the merger's window from the previous test run out, so a test starts "quiet"
    await wait(5100);
  });

  afterAll(async () => {
    socket.close();
    warn.mockRestore();
    await app.close();
  });

  it('an XADDed event → event.created with snapshotUrl, and the row already exists when it arrives', async () => {
    const seenAtEmit: Promise<number>[] = [];
    const real = gateway.toAlerts.bind(gateway);
    const spy = jest
      .spyOn(gateway, 'toAlerts')
      .mockImplementation((name, payload) => {
        if (name === 'event.created') {
          // asked at the moment of the push: the row must be visible to another connection
          seenAtEmit.push(
            ownerQuery(
              `SELECT count(*)::int AS n FROM "Event" WHERE "id" = $1`,
              (payload as { id: string }).id,
            ).then((rows) => (rows as { n: number }[])[0].n),
          );
        }
        real(name, payload);
      });
    try {
      const msg = eventMsg({
        snapshotPath: 'cam_a/2026-10-09/evt_pushed.jpg',
        configVersion: 4,
      });
      await xadd(msg);
      await waitFor(
        async () => named('event.created').length > 0,
        'event.created',
      );

      const created = named('event.created')[0].payload;
      expect(created).toEqual({
        id: msg.id,
        time: '2026-10-09T10:00:00.000Z',
        cameraId: 'cam_a',
        useCase: 'cashier_presence',
        type: 'cashier_unattended',
        severity: 'warning',
        data: { absentSec: 12 },
        snapshotUrl: '/media/snapshots/cam_a/2026-10-09/evt_pushed.jpg',
      });
      expect(await Promise.all(seenAtEmit)).toEqual([1]);

      const { validator } = app.get(ContractsService);
      await waitFor(
        async () => named('data.changed').length > 0,
        'data.changed',
      );
      for (const m of received) {
        expect([
          m.name,
          validator.validateWsMessage(m.name, m.payload),
        ]).toEqual([m.name, { ok: true }]);
      }
      expect(named('data.changed')[0].payload).toEqual({
        cameraIds: ['cam_a'],
        useCases: ['cashier_presence'],
        shapes: ['event'],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('one commit with 60 new events → no event.created and one data.changed', async () => {
    await ingest.processBatch(entries(eventsOf(60)));
    await wait(300);

    expect(named('event.created')).toHaveLength(0);
    expect(named('data.changed')).toHaveLength(1);
    expect(named('data.changed')[0].payload).toEqual({
      cameraIds: ['cam_a'],
      useCases: ['cashier_presence'],
      shapes: ['event'],
    });
  });

  it('50 new events are 50 event.created, 51 are none', async () => {
    await ingest.processBatch(entries(eventsOf(50)));
    await wait(300);
    expect(named('event.created')).toHaveLength(50);
    expect(named('data.changed')).toHaveLength(1);

    received = [];
    await wait(5100);
    await ingest.processBatch(entries(eventsOf(51)));
    await wait(300);
    expect(named('event.created')).toHaveLength(0);
    expect(named('data.changed')).toHaveLength(1);
  });

  it('a redelivered, already stored event → no event.created', async () => {
    const batch = entries([eventMsg()]);
    await ingest.processBatch(batch);
    await waitFor(
      async () => named('event.created').length === 1,
      'first push',
    );
    await wait(5100); // the window of the first data.changed is over

    received = [];
    await ingest.processBatch(batch); // the same entry again
    await wait(400);

    expect(named('event.created')).toHaveLength(0);
    expect(named('data.changed')).toHaveLength(0);
  });

  it('interval opens and closes and metric upserts are data.changed shapes; a repeated close is not', async () => {
    const open = openMsg({ cameraId: 'cam_b' });
    await ingest.processBatch(
      entries([
        open,
        metricMsg({ cameraId: 'cam_b' }),
        closeMsg({ cameraId: 'cam_b', sessionId: open.sessionId }),
      ]),
    );
    await waitFor(
      async () => named('data.changed').length === 1,
      'data.changed',
    );
    expect(named('event.created')).toHaveLength(0);
    expect(named('data.changed')[0].payload).toEqual({
      cameraIds: ['cam_b'],
      useCases: ['cashier_presence', 'restaurant_table'],
      shapes: ['interval', 'metric'],
    });

    await wait(5100);
    received = [];
    await ingest.processBatch(
      entries([closeMsg({ cameraId: 'cam_b', sessionId: open.sessionId })]),
    );
    await wait(400);
    expect(named('data.changed')).toHaveLength(0);
  });

  it('a transaction that fails (database down) pushes nothing; once it works the push comes', async () => {
    const prisma = app.get(PrismaService);
    const down = jest.spyOn(prisma, '$transaction').mockRejectedValue(
      Object.assign(new Error("Can't reach database server"), {
        code: 'P1001',
      }),
    );
    const batch = entries([eventMsg()]);
    try {
      await expect(ingest.processBatch(batch)).rejects.toThrow();
      await wait(400);
      expect(received).toEqual([]);
    } finally {
      down.mockRestore();
    }

    await ingest.processBatch(batch);
    await waitFor(async () => named('event.created').length === 1, 'the push');
  });

  it('a gateway error does not stop ingest: the next entry is still written', async () => {
    const before = await count('Event');
    const boom = jest.spyOn(gateway, 'toAlerts').mockImplementation(() => {
      throw new Error('socket server is gone');
    });
    try {
      await expect(ingest.processBatch(entries([eventMsg()]))).resolves.toBe(
        false,
      );
    } finally {
      boom.mockRestore();
    }
    expect(await count('Event')).toBe(before + 1);

    await wait(5100);
    received = [];
    await ingest.processBatch(entries([eventMsg()]));
    await waitFor(
      async () => named('event.created').length === 1,
      'the next push',
    );
    expect(await count('Event')).toBe(before + 2);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('socket server is gone'),
      ),
    ).toBe(true);
  });

  it('two commits within a second: the first data.changed at once, the second merged ~5 s later', async () => {
    const started = Date.now();
    await ingest.processBatch(entries([eventMsg({ cameraId: 'cam_a' })]));
    await wait(300);
    await ingest.processBatch(entries([metricMsg({ cameraId: 'cam_b' })]));

    await waitFor(
      async () => named('data.changed').length === 2,
      'both messages',
    );
    const [first, second] = named('data.changed');
    expect(first.at - started).toBeLessThan(1500);
    expect(second.at - first.at).toBeGreaterThan(3500);
    expect(second.payload).toEqual({
      cameraIds: ['cam_b'],
      useCases: ['cashier_presence'],
      shapes: ['metric'],
    });
  });
});
