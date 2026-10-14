import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import type Redis from 'ioredis';
import { ENV, type Env } from '../config/env';
import { REDIS } from '../redis/redis.module';
import {
  errorMessage,
  GROUP,
  IngestService,
  STREAM,
  type StreamEntry,
} from './ingest.service';

const CONSUMER = 'api-1';
const COUNT = 100;
const BLOCK_MS = 5_000;
/** Pause before re-reading entries that just failed, so their 5 attempts span seconds. */
const RETRY_DELAY_MS = 1_000;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

type ReadReply = [
  stream: string,
  items: [id: string, fields: string[] | null][],
][];

function toEntries(reply: ReadReply | null): StreamEntry[] {
  return (reply?.[0]?.[1] ?? []).map(([id, fields]) => {
    // fields is [name, value, ...]; null when the pending entry was trimmed from the stream
    const at = fields?.findIndex((f, i) => i % 2 === 0 && f === 'msg') ?? -1;
    return { id, msg: at >= 0 ? fields?.[at + 1] : undefined };
  });
}

/**
 * When INGEST=on, moves the Redis stream `events` into Postgres as consumer `api-1` of group
 * `api`: its own pending entries first (left by a crash or a failed batch), then new ones,
 * each batch through {@link IngestService.processBatch}. Errors back off 1 s, doubling to 30 s.
 */
@Injectable()
export class EventsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventsConsumer.name);
  private readonly stopping = new AbortController();
  private reader?: Redis;
  private loop?: Promise<void>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ingest: IngestService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.INGEST !== 'on') return;
    // XREADGROUP BLOCK holds its connection, so the reader gets its own. It must not inherit the
    // shared client's timeouts: a 5 s command timeout would cut every idle BLOCK read.
    const reader = this.redis.duplicate({
      maxRetriesPerRequest: null,
      commandTimeout: undefined,
    });
    reader.on('error', (err: Error) =>
      this.logger.warn(`stream reader: ${err.message}`),
    );
    this.reader = reader;
    this.loop = this.run(reader);
  }

  /** Runs before Prisma and the shared Redis client close: lets a batch in flight finish. */
  async onModuleDestroy(): Promise<void> {
    this.stopping.abort();
    this.reader?.disconnect(); // ends a BLOCK read and the reconnect attempts
    await this.loop;
  }

  private async run(reader: Redis): Promise<void> {
    let backoff = 0;
    let groupReady = false;
    while (!this.stopping.signal.aborted) {
      try {
        if (!groupReady) {
          await this.createGroup(reader);
          groupReady = true;
        }
        const entries = await this.read(reader);
        const retry =
          entries.length > 0 && (await this.ingest.processBatch(entries));
        backoff = 0;
        if (retry) await this.pause(RETRY_DELAY_MS);
      } catch (err) {
        if (this.stopping.signal.aborted) break;
        // Redis restarted without its data: create the group again on the next round
        if (errorMessage(err).startsWith('NOGROUP')) groupReady = false;
        backoff = Math.min(backoff * 2 || FIRST_BACKOFF_MS, MAX_BACKOFF_MS);
        this.logger.error(
          `ingest failed, retrying in ${backoff / 1000} s: ${errorMessage(err)}`,
        );
        await this.pause(backoff);
      }
    }
  }

  /** Sleeps `ms`, or less when the module is shutting down. */
  private async pause(ms: number): Promise<void> {
    await sleep(ms, undefined, { signal: this.stopping.signal }).catch(
      () => undefined,
    );
  }

  private async createGroup(reader: Redis): Promise<void> {
    try {
      await reader.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!errorMessage(err).startsWith('BUSYGROUP')) throw err;
    }
  }

  /** This consumer's pending entries if it has any, else new entries (blocking up to 5 s). */
  private async read(reader: Redis): Promise<StreamEntry[]> {
    const pending = toEntries(
      await reader.xreadgroup(
        'GROUP',
        GROUP,
        CONSUMER,
        'COUNT',
        COUNT,
        'STREAMS',
        STREAM,
        '0',
      ),
    );
    if (pending.length > 0) return pending;
    return toEntries(
      await reader.xreadgroup(
        'GROUP',
        GROUP,
        CONSUMER,
        'COUNT',
        COUNT,
        'BLOCK',
        BLOCK_MS,
        'STREAMS',
        STREAM,
        '>',
      ),
    );
  }
}
