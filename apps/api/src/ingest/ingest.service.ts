import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  EventMessage,
  IntervalCloseMessage,
  IntervalOpenMessage,
  Message,
  MetricMessage,
} from '@zoo-vision/contracts';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import { ContractsService } from '../contracts/contracts.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isTransient } from '../prisma/transient';
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
type Applied = { dead: DeadLetter[]; changes: Changes };
type DeadLetter = { streamId: string; payload: string; reason: string };
/** An entry after parsing and validation: a message to apply, or why it is dead. */
type Parsed =
  | { entry: StreamEntry; message: Message }
  | { entry: StreamEntry; reason: string };

export type IngestShape = 'event' | 'interval' | 'metric';

/** What one committed transaction wrote, for the push to the dashboard (nothing it already had). */
export type IngestCommit = {
  /** Only the events this commit inserted: a redelivered one is not here. */
  events: EventMessage[];
  cameraIds: string[];
  useCases: string[];
  shapes: IngestShape[];
};

/** Collects what a transaction really changed: a conflicting insert or a repeated close is nothing. */
class Changes {
  readonly events: EventMessage[] = [];
  private readonly cameras = new Set<string>();
  private readonly useCases = new Set<string>();
  private readonly shapes = new Set<IngestShape>();

  wrote(shape: IngestShape, m: Message): void {
    this.shapes.add(shape);
    if (m.cameraId !== null) this.cameras.add(m.cameraId);
    this.useCases.add(m.useCase);
  }

  /** The commit to announce, or null when the transaction changed no data row. */
  commit(): IngestCommit | null {
    if (this.shapes.size === 0) return null;
    return {
      events: this.events,
      cameraIds: [...this.cameras].sort(),
      useCases: [...this.useCases].sort(),
      shapes: [...this.shapes].sort(),
    };
  }
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Postgres `text` cannot hold NUL; a raw one would make the dead letter itself fail forever. */
const storable = (s: string) => s.replaceAll('\u0000', '\\u0000');

const deadLetter = (entry: StreamEntry, reason: string): DeadLetter => ({
  streamId: entry.id,
  payload: storable(entry.msg ?? ''),
  reason: storable(reason),
});

/** The entry's camera; null for system messages and entries that could not be read. */
const cameraOf = (item: Parsed) =>
  'message' in item ? item.message.cameraId : null;

/**
 * Writes stream messages to Postgres. Every write is idempotent (Event by id, Interval by
 * sessionId, Metric by camera/name/minute), so an entry delivered twice changes nothing.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  /**
   * Emitted after the XACK of every applied transaction that changed a data row (a batch, or one
   * entry of a one-by-one retry). Never emitted for a failed transaction.
   */
  readonly committed$ = new Subject<IngestCommit>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Applies `entries` in stream order in one transaction, then XACKs them. Invalid entries become
   * DeadEvents. If the transaction fails with an error that says nothing about the entries (a
   * transient one, or Postgres not answering `SELECT 1`), this rethrows with nothing acked,
   * counted or dead-lettered. Otherwise each entry gets its own transaction, and one that fails
   * {@link MAX_ATTEMPTS} times (counted in {@link FAILURES}) is dead-lettered. Returns true when
   * an entry was counted and left pending, so the caller should pause before re-reading it.
   */
  async processBatch(entries: StreamEntry[]): Promise<boolean> {
    if (entries.length === 0) return false;
    const parsed = entries.map((entry) => this.parse(entry));
    let applied: Applied;
    try {
      applied = await this.apply(parsed);
    } catch (err) {
      await this.rethrowUnlessEntryFault(err);
      return this.oneByOne(parsed);
    }
    await this.ackThenPublish(
      entries.map((e) => e.id),
      applied.changes,
    );
    this.warnDead(applied.dead);
    return false;
  }

  /**
   * Keeps per-camera order: once an entry fails (and stays), the later entries of its camera wait
   * for the next pass, unapplied, unacked and uncounted. A failed system entry (camera null) holds
   * back everything after it, and a system entry waits behind any held-back camera.
   */
  private async oneByOne(parsed: Parsed[]): Promise<boolean> {
    let pending = false;
    const held = new Set<string | null>();
    for (const item of parsed) {
      const camera = cameraOf(item);
      const waits =
        held.has(null) || (camera === null ? held.size > 0 : held.has(camera));
      if (waits) continue;
      let applied: Applied;
      try {
        applied = await this.apply([item]);
      } catch (err) {
        // a transient error, or the database gone since the probe, is never the entry's fault
        await this.rethrowUnlessEntryFault(err);
        if (!(await this.countFailure(item.entry, err))) {
          held.add(camera);
          pending = true;
        }
        continue;
      }
      await this.ackThenPublish([item.entry.id], applied.changes);
      this.warnDead(applied.dead);
    }
    return pending;
  }

  /** Counts a failed attempt. Returns true when it was the last one and the entry is dead. */
  private async countFailure(
    entry: StreamEntry,
    err: unknown,
  ): Promise<boolean> {
    const attempts = await this.redis.hincrby(FAILURES, entry.id, 1);
    if (attempts < MAX_ATTEMPTS) return false;
    const dead = deadLetter(entry, errorMessage(err));
    await this.prisma.deadEvent.create({ data: dead });
    await this.ack([entry.id]);
    this.warnDead([dead]);
    return true;
  }

  /** Rethrows `err` when it says nothing about the entry: transient, or Postgres is down. */
  private async rethrowUnlessEntryFault(err: unknown): Promise<void> {
    if (isTransient(err)) throw err;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw err;
    }
  }

  /**
   * XACKs, then announces what the transaction wrote. The announcement also goes out when the
   * XACK fails: the rows are committed, the redelivery will insert nothing and so never announce
   * them, and a browser must be told.
   */
  private async ackThenPublish(ids: string[], changes: Changes): Promise<void> {
    try {
      await this.ack(ids);
    } finally {
      this.publish(changes);
    }
  }

  /** A subscriber that throws must not be able to hurt ingest. */
  private publish(changes: Changes): void {
    const commit = changes.commit();
    if (!commit) return;
    try {
      this.committed$.next(commit);
    } catch (err) {
      this.logger.warn(`push after commit failed: ${errorMessage(err)}`);
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

  /**
   * One transaction for all of `parsed`, in stream order. Returns the dead letters it wrote and
   * what it changed (meaningful once the transaction has committed, i.e. when this returns).
   */
  private apply(parsed: Parsed[]): Promise<Applied> {
    return this.prisma.$transaction(async (tx) => {
      const cameras = await this.knownCameras(tx, parsed);
      const dead: DeadLetter[] = [];
      const changes = new Changes();
      for (const item of parsed) {
        const reason =
          'reason' in item
            ? item.reason
            : await this.applyMessage(tx, item.message, cameras, changes);
        if (reason === undefined) continue;
        const letter = deadLetter(item.entry, reason);
        await tx.deadEvent.create({ data: letter });
        dead.push(letter);
      }
      return { dead, changes };
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
    changes: Changes,
  ): Promise<string | undefined> {
    if (message.cameraId !== null && !cameras.has(message.cameraId)) {
      return `unknown camera ${message.cameraId}`;
    }
    switch (message.message) {
      case 'event':
        return this.applyEvent(tx, message, changes);
      case 'interval_open':
        return this.applyOpen(tx, message, changes);
      case 'interval_close':
        return this.applyClose(tx, message, changes);
      case 'metric':
        return this.applyMetric(tx, message, changes);
      default: {
        // the envelope admits only the four kinds above; a new one must not be acked unwritten
        const unsupported: never = message;
        return `unsupported message ${String((unsupported as { message?: unknown }).message)}`;
      }
    }
  }

  private async applyEvent(
    tx: Tx,
    m: EventMessage,
    changes: Changes,
  ): Promise<undefined> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "Event" ("id", "time", "cameraId", "useCase", "type", "severity",
                           "configVersion", "schemaVersion", "snapshotPath", "data")
      VALUES (${m.id}, ${m.time}::timestamptz, ${m.cameraId}, ${m.useCase}, ${m.type},
              ${m.severity}::"Severity", ${m.configVersion}::int, ${m.schemaVersion}::int,
              ${m.snapshotPath}, ${JSON.stringify(m.data)}::jsonb)
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted === 1) {
      changes.events.push(m);
      changes.wrote('event', m);
    }
    // Closes the previous boot's intervals. Only a first delivery does it (a redelivered
    // engine_started must not close what the restarted engine opened since), and only intervals
    // that started before the restart (a late one, e.g. retried per entry, must not either).
    if (
      inserted === 1 &&
      m.useCase === 'system' &&
      m.type === 'engine_started'
    ) {
      const { engineGroup } = m.data as { engineGroup: string };
      const restarted = await tx.$executeRaw`
        UPDATE "Interval" SET "end" = ${m.time}::timestamptz, "endReason" = 'engine_restart'
         WHERE "end" IS NULL AND "useCase" <> 'system'
           AND "start" <= ${m.time}::timestamptz
           AND "cameraId" IN (SELECT "id" FROM "Camera" WHERE "engineGroup" = ${engineGroup})`;
      if (restarted > 0) changes.wrote('interval', m);
    }
    return undefined;
  }

  private async applyOpen(
    tx: Tx,
    m: IntervalOpenMessage,
    changes: Changes,
  ): Promise<undefined> {
    const opened = await tx.$executeRaw`
      INSERT INTO "Interval" ("id", "cameraId", "useCase", "kind", "subjectId", "start",
                              "configVersion", "schemaVersion", "data")
      VALUES (${m.sessionId}, ${m.cameraId}, ${m.useCase}, ${m.kind}, ${m.subjectId},
              ${m.time}::timestamptz, ${m.configVersion}::int, ${m.schemaVersion}::int,
              ${JSON.stringify(m.data)}::jsonb)
      ON CONFLICT ("id") DO NOTHING`;
    if (opened === 1) changes.wrote('interval', m);
    return undefined;
  }

  private async applyClose(
    tx: Tx,
    m: IntervalCloseMessage,
    changes: Changes,
  ): Promise<string | undefined> {
    const closed = await tx.$executeRaw`
      UPDATE "Interval"
         SET "end" = ${m.time}::timestamptz, "endReason" = ${m.endReason},
             "data" = "data" || ${JSON.stringify(m.data)}::jsonb
       WHERE "id" = ${m.sessionId} AND "end" IS NULL`;
    if (closed > 0) {
      changes.wrote('interval', m);
      return undefined;
    }
    const existing = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "Interval" WHERE "id" = ${m.sessionId}`;
    // already closed (a redelivery, or engine_restart got there first): nothing to do
    return existing.length > 0
      ? undefined
      : `close for unknown interval ${m.sessionId}`;
  }

  private async applyMetric(
    tx: Tx,
    m: MetricMessage,
    changes: Changes,
  ): Promise<undefined> {
    await tx.$executeRaw`
      INSERT INTO "Metric" ("cameraId", "useCase", "name", "minute", "value")
      VALUES (${m.cameraId}, ${m.useCase}, ${m.name}, ${m.time}::timestamptz,
              ${m.value}::double precision)
      ON CONFLICT ("cameraId", "name", "minute") DO UPDATE SET "value" = EXCLUDED."value"`;
    changes.wrote('metric', m);
    return undefined;
  }
}
