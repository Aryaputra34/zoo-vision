import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ContractsService } from '../contracts/contracts.service';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { IngestService, type StreamEntry } from './ingest.service';

const hex = (n: number) => String(n).padStart(32, '0');
const envelope = (useCase: string, cameraId: string | null) => ({
  cameraId,
  useCase,
  schemaVersion: 1,
  configVersion: null,
  time: '2026-10-09T10:00:00.000Z',
});

const event = (n: number, cameraId = 'cam_a') =>
  JSON.stringify({
    message: 'event',
    ...envelope('cashier_presence', cameraId),
    id: `evt_${hex(n)}`,
    type: 'cashier_unattended',
    severity: 'warning',
    snapshotPath: null,
    data: { absentSec: 12 },
  });

const engineStarted = (n: number) =>
  JSON.stringify({
    message: 'event',
    ...envelope('system', null),
    id: `evt_${hex(n)}`,
    type: 'engine_started',
    severity: 'info',
    snapshotPath: null,
    data: { bootId: hex(n), engineGroup: 'default' },
  });

const open = (n: number, cameraId = 'cam_a') =>
  JSON.stringify({
    message: 'interval_open',
    ...envelope('restaurant_table', cameraId),
    sessionId: `ses_${hex(n)}`,
    kind: 'table_session',
    subjectId: 'T1',
    data: { tableName: 'Table 1' },
  });

const close = (n: number, cameraId = 'cam_a') =>
  JSON.stringify({
    message: 'interval_close',
    ...envelope('restaurant_table', cameraId),
    time: '2026-10-09T10:05:00.000Z',
    sessionId: `ses_${hex(n)}`,
    kind: 'table_session',
    endReason: 'ended',
    data: {},
  });

const sqlOf = (strings: TemplateStringsArray) => strings.join('?').trim();

/**
 * A PrismaService stand-in: `$transaction` runs the callback against the same mock, every camera
 * exists, and `execute` decides what each write does.
 */
function mockPrisma(opts: {
  transaction?: () => Promise<never>;
  probe?: () => Promise<unknown>;
  execute?: (sql: string, values: unknown[]) => Promise<number>;
}) {
  const prisma = {
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOf(strings);
        if (sql === 'SELECT 1') {
          return opts.probe ? opts.probe() : Promise.resolve([{ x: 1 }]);
        }
        if (sql.includes('FROM "Camera"')) {
          return Promise.resolve((values[0] as string[]).map((id) => ({ id })));
        }
        return Promise.resolve([]);
      },
    ),
    $executeRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        opts.execute
          ? opts.execute(sqlOf(strings), values)
          : Promise.resolve(1),
    ),
    deadEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
        opts.transaction ? opts.transaction() : fn(prisma),
    ),
  };
  return prisma;
}

/** A Redis stand-in with a real `ingest:failures` hash. */
function mockRedis() {
  const failures = new Map<string, number>();
  return {
    failures,
    xack: jest.fn().mockResolvedValue(1),
    hincrby: jest.fn((_key: string, field: string, by: number) => {
      failures.set(field, (failures.get(field) ?? 0) + by);
      return Promise.resolve(failures.get(field));
    }),
    hdel: jest.fn((_key: string, ...fields: string[]) => {
      fields.forEach((f) => failures.delete(f));
      return Promise.resolve(fields.length);
    }),
  };
}

const ackedIds = (redis: ReturnType<typeof mockRedis>) =>
  redis.xack.mock.calls.flatMap((args: unknown[]) => args.slice(2));
const countedIds = (redis: ReturnType<typeof mockRedis>) =>
  redis.hincrby.mock.calls.map(([, field]) => field);
const executed = (prisma: ReturnType<typeof mockPrisma>) =>
  prisma.$executeRaw.mock.calls.map(([strings, ...values]) => ({
    sql: sqlOf(strings),
    values,
  }));

/** The error Prisma 7 + adapter-pg throws when a raw query fails with `sqlstate`. */
const rawQueryFailed = (sqlstate: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Raw query failed. Code: \`${sqlstate}\`. Message: \`${message}\``,
    {
      code: 'P2010',
      clientVersion: '7',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode: sqlstate, kind: 'postgres', code: sqlstate },
        },
      },
    },
  );

describe('IngestService.processBatch', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const service = (
    prisma: ReturnType<typeof mockPrisma>,
    redis: ReturnType<typeof mockRedis>,
    contracts = new ContractsService(),
  ) =>
    new IngestService(
      prisma as unknown as PrismaService,
      contracts,
      redis as unknown as Redis,
    );

  it('when the batch transaction fails and SELECT 1 fails, it rethrows and calls neither XACK, HINCRBY nor DeadEvent insert', async () => {
    const down = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const prisma = mockPrisma({
      transaction: () => Promise.reject(down),
      probe: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    const redis = mockRedis();
    const entries: StreamEntry[] = [
      { id: '1-0', msg: '{not json' },
      { id: '1-1', msg: event(1) },
    ];

    await expect(service(prisma, redis).processBatch(entries)).rejects.toBe(
      down,
    );

    const queries = prisma.$queryRaw.mock.calls.map(([s]) => sqlOf(s));
    expect(queries).toContain('SELECT 1');
    expect(redis.xack).not.toHaveBeenCalled();
    expect(redis.hincrby).not.toHaveBeenCalled();
    expect(redis.hdel).not.toHaveBeenCalled();
    expect(prisma.deadEvent.create).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('when one entry keeps failing with the database up, it is dead-lettered on the fifth batch and acked; the others are acked on the first', async () => {
    const badId = `evt_${hex(2)}`;
    const prisma = mockPrisma({
      execute: (_sql, values) =>
        values.includes(badId)
          ? Promise.reject(new Error('date/time field value out of range'))
          : Promise.resolve(1),
    });
    const redis = mockRedis();
    const ingest = service(prisma, redis);
    const bad = { id: '1-2', msg: event(2, 'cam_a') };

    // the others are other cameras' entries, so the failure does not hold them back
    await ingest.processBatch([
      { id: '1-1', msg: event(1, 'cam_b') },
      bad,
      { id: '1-3', msg: event(3, 'cam_c') },
    ]);
    expect(ackedIds(redis)).toEqual(['1-1', '1-3']);
    expect(redis.failures.get('1-2')).toBe(1);

    for (let attempt = 2; attempt <= 4; attempt++) {
      await ingest.processBatch([bad]);
      expect(redis.failures.get('1-2')).toBe(attempt);
    }
    expect(ackedIds(redis)).toEqual(['1-1', '1-3']);
    expect(prisma.deadEvent.create).not.toHaveBeenCalled();

    await ingest.processBatch([bad]);

    expect(prisma.deadEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.deadEvent.create).toHaveBeenCalledWith({
      data: {
        streamId: '1-2',
        payload: bad.msg,
        reason: 'date/time field value out of range',
      },
    });
    expect(ackedIds(redis)).toEqual(['1-1', '1-3', '1-2']);
    expect(redis.failures.has('1-2')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [[warning]] = warn.mock.calls as [string][];
    expect(warning).toContain('1-2');
    expect(warning).toContain('date/time field value out of range');
  });

  it('open(S) fails while close(S) on the same camera is held back: not applied, not acked, not counted', async () => {
    let openFails = true;
    const prisma = mockPrisma({
      execute: (sql) =>
        openFails && sql.startsWith('INSERT INTO "Interval"')
          ? Promise.reject(new Error('value too long for type text'))
          : Promise.resolve(1),
    });
    const redis = mockRedis();
    const ingest = service(prisma, redis);
    const openS = { id: '2-1', msg: open(7, 'cam_a') };
    const closeS = { id: '2-2', msg: close(7, 'cam_a') };

    await ingest.processBatch([
      openS,
      closeS,
      { id: '2-3', msg: event(3, 'cam_b') },
    ]);

    expect(ackedIds(redis)).toEqual(['2-3']);
    expect(countedIds(redis)).toEqual(['2-1']);
    expect(
      executed(prisma).filter((s) => s.sql.startsWith('UPDATE "Interval"')),
    ).toEqual([]);
    expect(prisma.deadEvent.create).not.toHaveBeenCalled();

    // the next loop re-reads both in order; now the open lands first, then the close
    openFails = false;
    prisma.$executeRaw.mockClear();
    await ingest.processBatch([openS, closeS]);

    const kinds = executed(prisma).map(({ sql }) =>
      sql.startsWith('INSERT INTO "Interval"')
        ? 'open'
        : sql.startsWith('UPDATE "Interval"')
          ? 'close'
          : sql,
    );
    expect(kinds).toEqual(['open', 'close']);
    expect(ackedIds(redis)).toEqual(['2-3', '2-1', '2-2']);
    expect(redis.failures.size).toBe(0);
    expect(prisma.deadEvent.create).not.toHaveBeenCalled();
  });

  it('a failed system entry holds back everything after it', async () => {
    const startedId = `evt_${hex(1)}`;
    const prisma = mockPrisma({
      execute: (_sql, values) =>
        values.includes(startedId)
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(1),
    });
    const redis = mockRedis();

    await service(prisma, redis).processBatch([
      { id: '3-1', msg: engineStarted(1) },
      { id: '3-2', msg: event(2, 'cam_a') },
      { id: '3-3', msg: event(3, 'cam_b') },
    ]);

    expect(redis.xack).not.toHaveBeenCalled();
    expect(countedIds(redis)).toEqual(['3-1']);
    for (const statement of executed(prisma)) {
      expect(statement.values).toContain(startedId);
    }
  });

  it('a system entry after a held-back camera entry waits too; other cameras keep flowing', async () => {
    const badId = `evt_${hex(1)}`;
    const prisma = mockPrisma({
      execute: (_sql, values) =>
        values.includes(badId)
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(1),
    });
    const redis = mockRedis();

    await service(prisma, redis).processBatch([
      { id: '4-1', msg: event(1, 'cam_a') },
      { id: '4-2', msg: engineStarted(2) },
      { id: '4-3', msg: event(3, 'cam_b') },
    ]);

    expect(ackedIds(redis)).toEqual(['4-3']);
    expect(countedIds(redis)).toEqual(['4-1']);
  });

  describe.each([
    [
      'a lock timeout (55P03)',
      rawQueryFailed('55P03', 'canceling statement due to lock timeout'),
    ],
    [
      'a Prisma pool timeout (P2024)',
      new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a new connection from the connection pool.',
        { code: 'P2024', clientVersion: '7' },
      ),
    ],
  ])('%s with the database up', (_name, transient) => {
    const entries: StreamEntry[] = [
      { id: '5-1', msg: event(1, 'cam_a') },
      { id: '5-2', msg: event(2, 'cam_b') },
    ];
    const expectNothingDone = (
      prisma: ReturnType<typeof mockPrisma>,
      redis: ReturnType<typeof mockRedis>,
    ) => {
      expect(redis.hincrby).not.toHaveBeenCalled();
      expect(redis.xack).not.toHaveBeenCalled();
      expect(prisma.deadEvent.create).not.toHaveBeenCalled();
    };

    it('in the batch transaction: rejects with no HINCRBY, no XACK and no DeadEvent', async () => {
      const prisma = mockPrisma({ execute: () => Promise.reject(transient) });
      const redis = mockRedis();

      await expect(service(prisma, redis).processBatch(entries)).rejects.toBe(
        transient,
      );
      expectNothingDone(prisma, redis);
    });

    it('in the per-entry fallback: rejects with no HINCRBY, no XACK and no DeadEvent', async () => {
      const execute = jest
        .fn<Promise<number>, [string, unknown[]]>()
        .mockRejectedValueOnce(new Error('value too long for type text'))
        .mockRejectedValue(transient);
      const prisma = mockPrisma({ execute });
      const redis = mockRedis();

      await expect(service(prisma, redis).processBatch(entries)).rejects.toBe(
        transient,
      );
      expect(execute).toHaveBeenCalledTimes(2); // the batch, then the first entry alone
      expectNothingDone(prisma, redis);
    });
  });

  it('an unsupported message kind is dead-lettered, not acked silently', async () => {
    const lenient = {
      validator: { validateMessage: () => ({ ok: true }) },
    } as unknown as ContractsService;
    const prisma = mockPrisma({});
    const redis = mockRedis();
    const msg = JSON.stringify({ message: 'heartbeat', cameraId: 'cam_a' });

    await service(prisma, redis, lenient).processBatch([{ id: '6-1', msg }]);

    expect(prisma.deadEvent.create).toHaveBeenCalledWith({
      data: {
        streamId: '6-1',
        payload: msg,
        reason: 'unsupported message heartbeat',
      },
    });
    expect(ackedIds(redis)).toEqual(['6-1']);
  });
});
