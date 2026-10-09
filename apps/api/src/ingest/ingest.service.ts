import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  EventMessage,
  IntervalCloseMessage,
  IntervalOpenMessage,
  Message,
  MetricMessage,
} from '@zoo-vision/contracts';
import type Redis from 'ioredis';
import { ContractsService } from '../contracts/contracts.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

export const STREAM = 'events';
export const GROUP = 'api';
/** Hash of failed attempts per stream id, for entries that fail while the database is up. */
const FAILURES = 'ingest:failures';
/** Attempts after which a failing entry is dead-lettered. */
const MAX_ATTEMPTS = 5;

/** A stream entry; `msg` is undefined when the entry has no `msg` field (or was trimmed). */
export type StreamEntry = { id: string; msg: string | undefined };

type Tx = Prisma.TransactionClient;
type DeadLetter = { streamId: string; payload: string; reason: string };
/** An entry after parsing and validation: a message to apply, or why it is dead. */
type Parsed =
  | { entry: StreamEntry; message: Message }
  | { entry: StreamEntry; reason: string };

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Writes stream messages to Postgres. Every write is idempotent (Event by id, Interval by
 * sessionId, Metric by camera/name/minute), so an entry delivered twice changes nothing.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Applies `entries` in stream order in one transaction, then XACKs them. Invalid entries become
   * DeadEvents. If the transaction fails, Postgres is probed: when it is down this rethrows with
   * nothing acked, counted or dead-lettered; when it is up each entry gets its own transaction,
   * and one that fails {@link MAX_ATTEMPTS} times (counted in {@link FAILURES}) is dead-lettered.
   */
  async processBatch(entries: StreamEntry[]): Promise<void> {
    if (entries.length === 0) return;
    let dead: DeadLetter[];
    try {
      dead = await this.apply(entries);
    } catch (err) {
      await this.assertDatabaseUp(err);
      return this.oneByOne(entries);
    }
    await this.ack(entries.map((e) => e.id));
    this.warnDead(dead);
  }

  private async oneByOne(entries: StreamEntry[]): Promise<void> {
    for (const entry of entries) {
      let dead: DeadLetter[];
      try {
        dead = await this.apply([entry]);
      } catch (err) {
        // the database may have gone down since the probe; that is never the entry's fault
        await this.assertDatabaseUp(err);
        await this.countFailure(entry, err);
        continue;
      }
      await this.ack([entry.id]);
      this.warnDead(dead);
    }
  }

  private async countFailure(entry: StreamEntry, err: unknown): Promise<void> {
    const attempts = await this.redis.hincrby(FAILURES, entry.id, 1);
    if (attempts < MAX_ATTEMPTS) return;
    const dead = {
      streamId: entry.id,
      payload: entry.msg ?? '',
      reason: errorMessage(err),
    };
    await this.prisma.deadEvent.create({ data: dead });
    await this.ack([entry.id]);
    this.warnDead([dead]);
  }

  /** Rethrows `cause` when Postgres does not answer `SELECT 1`. */
  private async assertDatabaseUp(cause: unknown): Promise<void> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw cause;
    }
  }

  private async ack(ids: string[]): Promise<void> {
    await this.redis.xack(STREAM, GROUP, ...ids);
    await this.redis.hdel(FAILURES, ...ids);
  }

  private warnDead(dead: DeadLetter[]): void {
    for (const d of dead) {
      this.logger.warn(`dead-lettered stream entry ${d.streamId}: ${d.reason}`);
    }
  }

  /** One transaction for all of `entries`, in stream order. Returns the dead letters it wrote. */
  private apply(entries: StreamEntry[]): Promise<DeadLetter[]> {
    const parsed = entries.map((entry) => this.parse(entry));
    return this.prisma.$transaction(async (tx) => {
      const cameras = await this.knownCameras(tx, parsed);
      const dead: DeadLetter[] = [];
      for (const item of parsed) {
        const reason =
          'reason' in item
            ? item.reason
            : await this.applyMessage(tx, item.message, cameras);
        if (reason === undefined) continue;
        const letter = {
          streamId: item.entry.id,
          payload: item.entry.msg ?? '',
          reason,
        };
        await tx.deadEvent.create({ data: letter });
        dead.push(letter);
      }
      return dead;
    });
  }

  private parse(entry: StreamEntry): Parsed {
    if (entry.msg === undefined) return { entry, reason: 'no msg field' };
    let value: unknown;
    try {
      value = JSON.parse(entry.msg);
    } catch {
      return { entry, reason: 'invalid JSON' };
    }
    const result = this.contracts.validator.validateMessage(value);
    if (!result.ok) {
      const [first] = result.errors;
      return { entry, reason: `${first.path || '/'}: ${first.message}` };
    }
    return { entry, message: value as Message };
  }

  private async knownCameras(tx: Tx, parsed: Parsed[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const item of parsed) {
      if ('message' in item && item.message.cameraId !== null) {
        ids.add(item.message.cameraId);
      }
    }
    if (ids.size === 0) return ids;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Camera" WHERE "id" = ANY(${[...ids]}::text[])`;
    return new Set(rows.map((r) => r.id));
  }

  /** Writes one valid message. Returns a dead-letter reason, or undefined when it applied. */
  private async applyMessage(
    tx: Tx,
    message: Message,
    cameras: Set<string>,
  ): Promise<string | undefined> {
    if (message.cameraId !== null && !cameras.has(message.cameraId)) {
      return `unknown camera ${message.cameraId}`;
    }
    switch (message.message) {
      case 'event':
        return this.applyEvent(tx, message);
      case 'interval_open':
        return this.applyOpen(tx, message);
      case 'interval_close':
        return this.applyClose(tx, message);
      case 'metric':
        return this.applyMetric(tx, message);
    }
  }

  private async applyEvent(tx: Tx, m: EventMessage): Promise<undefined> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "Event" ("id", "time", "cameraId", "useCase", "type", "severity",
                           "configVersion", "schemaVersion", "snapshotPath", "data")
      VALUES (${m.id}, ${m.time}::timestamptz, ${m.cameraId}, ${m.useCase}, ${m.type},
              ${m.severity}::"Severity", ${m.configVersion}::int, ${m.schemaVersion}::int,
              ${m.snapshotPath}, ${JSON.stringify(m.data)}::jsonb)
      ON CONFLICT ("id") DO NOTHING`;
    // Closes the previous boot's intervals. Only a first delivery does it (a redelivered
    // engine_started must not close what the restarted engine opened since), and only intervals
    // that started before the restart (a late one, e.g. retried per entry, must not either).
    if (
      inserted === 1 &&
      m.useCase === 'system' &&
      m.type === 'engine_started'
    ) {
      const { engineGroup } = m.data as { engineGroup: string };
      await tx.$executeRaw`
        UPDATE "Interval" SET "end" = ${m.time}::timestamptz, "endReason" = 'engine_restart'
         WHERE "end" IS NULL AND "useCase" <> 'system'
           AND "start" <= ${m.time}::timestamptz
           AND "cameraId" IN (SELECT "id" FROM "Camera" WHERE "engineGroup" = ${engineGroup})`;
    }
    return undefined;
  }

  private async applyOpen(tx: Tx, m: IntervalOpenMessage): Promise<undefined> {
    await tx.$executeRaw`
      INSERT INTO "Interval" ("id", "cameraId", "useCase", "kind", "subjectId", "start",
                              "configVersion", "schemaVersion", "data")
      VALUES (${m.sessionId}, ${m.cameraId}, ${m.useCase}, ${m.kind}, ${m.subjectId},
              ${m.time}::timestamptz, ${m.configVersion}::int, ${m.schemaVersion}::int,
              ${JSON.stringify(m.data)}::jsonb)
      ON CONFLICT ("id") DO NOTHING`;
    return undefined;
  }

  private async applyClose(
    tx: Tx,
    m: IntervalCloseMessage,
  ): Promise<string | undefined> {
    const closed = await tx.$executeRaw`
      UPDATE "Interval"
         SET "end" = ${m.time}::timestamptz, "endReason" = ${m.endReason},
             "data" = "data" || ${JSON.stringify(m.data)}::jsonb
       WHERE "id" = ${m.sessionId} AND "end" IS NULL`;
    if (closed > 0) return undefined;
    const existing = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "Interval" WHERE "id" = ${m.sessionId}`;
    // already closed (a redelivery, or engine_restart got there first): nothing to do
    return existing.length > 0
      ? undefined
      : `close for unknown interval ${m.sessionId}`;
  }

  private async applyMetric(tx: Tx, m: MetricMessage): Promise<undefined> {
    await tx.$executeRaw`
      INSERT INTO "Metric" ("cameraId", "useCase", "name", "minute", "value")
      VALUES (${m.cameraId}, ${m.useCase}, ${m.name}, ${m.time}::timestamptz,
              ${m.value}::double precision)
      ON CONFLICT ("cameraId", "name", "minute") DO UPDATE SET "value" = EXCLUDED."value"`;
    return undefined;
  }
}
