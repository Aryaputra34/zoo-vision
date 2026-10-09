import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ContractsService } from '../contracts/contracts.service';
import type { PrismaService } from '../prisma/prisma.service';
import { IngestService, type StreamEntry } from './ingest.service';

const event = (n: number) =>
  JSON.stringify({
    message: 'event',
    cameraId: 'cam_a',
    useCase: 'cashier_presence',
    schemaVersion: 1,
    configVersion: null,
    time: '2026-10-09T10:00:00.000Z',
    id: `evt_${String(n).padStart(32, '0')}`,
    type: 'cashier_unattended',
    severity: 'warning',
    snapshotPath: null,
    data: { absentSec: 12 },
  });

const sqlOf = (strings: TemplateStringsArray) => strings.join('?').trim();

/**
 * A PrismaService stand-in: `$transaction` runs the callback against the same mock, `cam_a`
 * exists, and `execute` decides what each write does.
 */
function mockPrisma(opts: {
  transaction?: () => Promise<never>;
  probe?: () => Promise<unknown>;
  execute?: (values: unknown[]) => Promise<number>;
}) {
  const prisma = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = sqlOf(strings);
      if (sql === 'SELECT 1') {
        return opts.probe ? opts.probe() : Promise.resolve([{ x: 1 }]);
      }
      if (sql.includes('FROM "Camera"')) {
        return Promise.resolve([{ id: 'cam_a' }]);
      }
      return Promise.resolve([]);
    }),
    $executeRaw: jest.fn(
      (_strings: TemplateStringsArray, ...values: unknown[]) =>
        opts.execute ? opts.execute(values) : Promise.resolve(1),
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
  ) =>
    new IngestService(
      prisma as unknown as PrismaService,
      new ContractsService(),
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
    const badId = `evt_${String(2).padStart(32, '0')}`;
    const prisma = mockPrisma({
      execute: (values) =>
        values.includes(badId)
          ? Promise.reject(new Error('date/time field value out of range'))
          : Promise.resolve(1),
    });
    const redis = mockRedis();
    const ingest = service(prisma, redis);
    const bad = { id: '1-2', msg: event(2) };

    await ingest.processBatch([
      { id: '1-1', msg: event(1) },
      bad,
      { id: '1-3', msg: event(3) },
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
});
