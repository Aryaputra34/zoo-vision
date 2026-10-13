import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Env } from '../config/env';
import { EventsConsumer } from './events-consumer.service';
import type { IngestService } from './ingest.service';

const mockSleep = jest.fn<Promise<void>, [number]>();
jest.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => mockSleep(ms),
}));

describe('EventsConsumer', () => {
  it('waits about a second before re-reading after a counted failure, not after a clean batch', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    mockSleep.mockImplementation((ms) => {
      order.push(`sleep ${ms}`);
      return Promise.resolve();
    });
    const entry = [['1-0', ['msg', '{}']]];
    let reads = 0;
    const reader = {
      on: jest.fn(),
      disconnect: jest.fn(),
      xgroup: jest.fn().mockResolvedValue('OK'),
      xreadgroup: jest.fn(() => {
        reads++;
        order.push(`read ${reads}`);
        if (reads === 3) void consumer.onModuleDestroy();
        return Promise.resolve([['events', entry]]);
      }),
    };
    const processBatch = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const consumer = new EventsConsumer(
      { INGEST: 'on' } as Env,
      { duplicate: () => reader } as unknown as Redis,
      { processBatch } as unknown as IngestService,
    );

    consumer.onApplicationBootstrap();
    await (consumer as unknown as { loop: Promise<void> }).loop;

    expect(order.slice(0, 3)).toEqual(['read 1', 'sleep 1000', 'read 2']);
    expect(order.filter((o) => o.startsWith('sleep'))).toHaveLength(1);
  });
});
