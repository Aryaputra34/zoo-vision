import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { createValidator } from '@zoo-vision/contracts';
import Redis from 'ioredis';
import type { EngineCamera } from '../engine-internal/engine-cameras.service';
import { DEMO_GROUP } from './demo-cameras';
import {
  closeOpen,
  type DemoState,
  historyMessages,
  liveMessages,
  liveStatusFields,
  type Message,
  newDemoState,
  snapshotPath,
} from './demo-generators';
import { hashString, mulberry32, type Rng } from './rng';

export type DemoFeedOptions = {
  redisUrl: string;
  apiUrl: string;
  engineToken: string;
  /** Where live events' snapshots go (the folder the API serves); null writes none. */
  snapshotDir: string | null;
  /** `<use case>.jpg` stills (apps/api/demo/frames). */
  framesDir: string;
  backfillDays: number;
  seed: number;
  tz: string;
  signal: AbortSignal;
  /**
   * Every `everyMs` the next camera (by id) sends nothing for `forMs`: offline intervals and the
   * offline UI get exercised. Default 10 min / 2 min; `false` switches it off (tests).
   */
  silence?: false | { everyMs: number; forMs: number };
  /** How often the camera list is fetched again without a notice (default 30 s). */
  resyncEveryMs?: number;
};

const DEFAULT_SILENCE = { everyMs: 10 * 60_000, forMs: 2 * 60_000 };
const DEFAULT_RESYNC_MS = 30_000;

/** Whether camera `index` of `count` (ordered by id) is silent at `nowMs`. */
export function isSilent(
  index: number,
  count: number,
  nowMs: number,
  silence: false | { everyMs: number; forMs: number },
): boolean {
  if (silence === false || count === 0) return false;
  const slot = Math.floor(nowMs / silence.everyMs);
  return (
    slot % count === index && nowMs - slot * silence.everyMs < silence.forMs
  );
}

/**
 * Wraps an async function so that a call made while it runs makes it run once more afterwards, and
 * several such calls make one more run: a notice that arrives mid-refresh is never lost.
 */
export function coalescing(fn: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    running = true;
    try {
      do {
        again = false;
        await fn();
      } while (again);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void run();
  };
}

const STREAM = 'events';
const STREAM_MAXLEN = 1_000_000;
/** Set once the history is written, so a restart does not write it again. */
const BACKFILL_KEY = 'demo:backfilled';
const STATUS_EVERY_MS = 5_000;
const STATUS_TTL_MS = 15_000;
const FRAME_EVERY_MS = 2_000;
const FRAME_TTL_MS = 10_000;
const DAY_MS = 24 * 60 * 60_000;
const BACKFILL_BATCH = 1_000;

const statusKey = (id: string) => `cam:${id}:status`;
const frameKey = (id: string) => `cam:${id}:frame`;

/**
 * Plays the engine's part for the demo cameras with no Python and no models: history through the
 * real ingest, live messages every second, `cam:{id}:status` every 5 s, a still every 2 s, and
 * `appliedVersion` that follows saved configs. It talks to the API over HTTP with the engine token,
 * like the engine does. Returns once `signal` aborts.
 */
export async function runDemoFeed(opts: DemoFeedOptions): Promise<void> {
  const log = new Logger('DemoFeed');
  const validator = createValidator();
  const redis = new Redis(opts.redisUrl);
  // blocking readers must not inherit the shared client's timeouts
  const subscriber = redis.duplicate({
    maxRetriesPerRequest: null,
    commandTimeout: undefined,
  });
  for (const client of [redis, subscriber]) {
    client.on('error', (err: Error) => log.warn(`redis: ${err.message}`));
  }
  const bootId = randomBytes(16).toString('hex');
  const states = new Map<string, DemoState>();
  const liveRngs = new Map<string, Rng>();
  const frames = new Map<string, Buffer | null>();
  const silence = opts.silence === undefined ? DEFAULT_SILENCE : opts.silence;
  let cameras: EngineCamera[] = [];
  let stopped = false;

  const frameOf = async (useCase: string): Promise<Buffer | null> => {
    if (!frames.has(useCase)) {
      frames.set(
        useCase,
        await readFile(join(opts.framesDir, `${useCase}.jpg`)).catch(() => {
          log.warn(`no still for ${useCase} in ${opts.framesDir}`);
          return null;
        }),
      );
    }
    return frames.get(useCase) ?? null;
  };

  async function fetchCameras(): Promise<EngineCamera[] | null> {
    try {
      const res = await fetch(
        `${opts.apiUrl}/internal/engine/cameras?group=${DEMO_GROUP}`,
        {
          headers: { Authorization: `Bearer ${opts.engineToken}` },
          signal: AbortSignal.any([opts.signal, AbortSignal.timeout(5_000)]),
        },
      );
      if (!res.ok) return null;
      return ((await res.json()) as { cameras: EngineCamera[] }).cameras;
    } catch {
      return null;
    }
  }

  /** Waits for the API: it may still be starting. */
  async function waitForCameras(): Promise<EngineCamera[]> {
    while (!opts.signal.aborted) {
      const found = await fetchCameras();
      if (found) return found;
      log.warn('the API does not answer yet; trying again in 2 s');
      await sleep(2_000, undefined, { signal: opts.signal }).catch(
        () => undefined,
      );
    }
    return [];
  }

  /** Validates and XADDs; an invalid message is logged and dropped (the generators never make one). */
  async function send(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i += BACKFILL_BATCH) {
      const pipeline = redis.pipeline();
      for (const msg of messages.slice(i, i + BACKFILL_BATCH)) {
        const result = validator.validateMessage(msg);
        if (!result.ok) {
          log.error(`dropped an invalid message: ${JSON.stringify(result)}`);
          continue;
        }
        pipeline.xadd(
          STREAM,
          'MAXLEN',
          '~',
          STREAM_MAXLEN,
          '*',
          'msg',
          JSON.stringify(msg),
        );
      }
      await pipeline.exec();
    }
  }

  const silentAt = (index: number, nowMs: number): boolean =>
    isSilent(index, cameras.length, nowMs, silence);

  async function publishStatus(now: Date): Promise<void> {
    const pipeline = redis.pipeline();
    cameras.forEach((camera, i) => {
      if (silentAt(i, now.getTime())) return;
      const state = states.get(camera.id) ?? newDemoState();
      pipeline.hset(
        statusKey(camera.id),
        liveStatusFields(camera, state, bootId, now),
      );
      pipeline.pexpire(statusKey(camera.id), STATUS_TTL_MS);
    });
    await pipeline.exec();
  }

  async function publishFrames(now: Date): Promise<void> {
    for (const [i, camera] of cameras.entries()) {
      if (silentAt(i, now.getTime())) continue;
      const jpeg = await frameOf(camera.useCase);
      if (jpeg) await redis.set(frameKey(camera.id), jpeg, 'PX', FRAME_TTL_MS);
    }
  }

  /** A live event's snapshot is the camera's still, copied under its camera and day. */
  async function attachSnapshot(camera: EngineCamera, msg: Message) {
    if (!opts.snapshotDir || msg.message !== 'event') return;
    const relative = snapshotPath(
      camera.id,
      msg.time as string,
      msg.id as string,
      opts.tz,
    );
    try {
      const target = join(opts.snapshotDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(opts.framesDir, `${camera.useCase}.jpg`), target);
      msg.snapshotPath = relative;
    } catch (err) {
      log.warn(`no snapshot for ${String(msg.id)}: ${(err as Error).message}`);
    }
  }

  /**
   * Takes the camera list the API just gave. A camera that left the group (disabled or deleted)
   * has its open intervals closed with `config_change` and its status removed, like the engine.
   */
  async function adopt(found: EngineCamera[]): Promise<void> {
    const gone = cameras.filter((c) => !found.some((f) => f.id === c.id));
    const closes: Message[] = [];
    for (const camera of gone) {
      const state = states.get(camera.id);
      if (state) {
        closes.push(...closeOpen(state, camera, Date.now(), 'config_change'));
      }
      states.delete(camera.id);
      liveRngs.delete(camera.id);
    }
    cameras = [...found].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const camera of cameras) {
      if (!states.has(camera.id)) states.set(camera.id, newDemoState());
      if (!liveRngs.has(camera.id)) {
        liveRngs.set(
          camera.id,
          mulberry32(((opts.seed + 1) ^ hashString(camera.id)) >>> 0),
        );
      }
    }
    if (gone.length > 0) {
      await send(closes);
      await redis.del(...gone.map((c) => statusKey(c.id)));
    }
  }

  /**
   * cfg:changed, a reconnect and a timer all end here: fetch the cameras again so appliedVersion and
   * configVersion follow the save. A notice that arrives mid-refresh runs it once more.
   */
  const refresh = coalescing(async () => {
    try {
      const found = await fetchCameras();
      if (found && !stopped) {
        await adopt(found);
        await publishStatus(new Date());
      }
    } catch (err) {
      log.warn(`refresh failed: ${(err as Error).message}`);
    }
  });

  try {
    const found = await waitForCameras();
    if (opts.signal.aborted) return;
    await adopt(found);
    log.log(`playing the engine for ${cameras.length} demo cameras`);

    await subscriber.subscribe('cfg:changed');
    subscriber.on('message', refresh);
    // a re-subscribe after a Redis restart may have missed notices: fetch again, as the engine does
    subscriber.on('ready', refresh);

    await send([
      {
        message: 'event',
        cameraId: null,
        useCase: 'system',
        schemaVersion: 1,
        configVersion: null,
        time: new Date().toISOString(),
        id: `evt_${randomBytes(16).toString('hex')}`,
        type: 'engine_started',
        severity: 'info',
        snapshotPath: null,
        data: { bootId, engineGroup: DEMO_GROUP },
      },
    ]);
    await publishStatus(new Date());

    const started = new Date();
    // the live clock starts where the history ends, so nothing falls in between
    for (const camera of cameras) {
      const state = states.get(camera.id) ?? newDemoState();
      const rng = liveRngs.get(camera.id) ?? Math.random;
      liveMessages(camera, started, state, rng, opts.tz);
    }
    if (opts.backfillDays > 0 && (await redis.exists(BACKFILL_KEY)) === 0) {
      const from = new Date(started.getTime() - opts.backfillDays * DAY_MS);
      let written = 0;
      for (const camera of cameras) {
        const rng = mulberry32((opts.seed ^ hashString(camera.id)) >>> 0);
        const history = historyMessages(camera, from, started, rng, opts.tz);
        await send(history);
        written += history.length;
      }
      await redis.set(BACKFILL_KEY, new Date().toISOString());
      log.log(`backfilled ${opts.backfillDays} days: ${written} messages`);
    }

    let lastStatus = Date.now();
    let lastFrame = 0;
    let lastResync = Date.now();
    const resyncEveryMs = opts.resyncEveryMs ?? DEFAULT_RESYNC_MS;
    while (!opts.signal.aborted) {
      const now = new Date();
      const nowMs = now.getTime();
      const out: Message[] = [];
      for (const [i, camera] of cameras.entries()) {
        const state = states.get(camera.id) ?? newDemoState();
        const rng = liveRngs.get(camera.id) ?? Math.random;
        // while silent the camera sends nothing, but its open intervals end (engine_stop)
        const due = liveMessages(
          camera,
          now,
          state,
          rng,
          opts.tz,
          silentAt(i, nowMs),
        );
        for (const msg of due) await attachSnapshot(camera, msg);
        out.push(...due);
      }
      if (out.length > 0) await send(out);
      if (nowMs - lastStatus >= STATUS_EVERY_MS) {
        await publishStatus(now);
        lastStatus = nowMs;
      }
      if (nowMs - lastFrame >= FRAME_EVERY_MS) {
        await publishFrames(now);
        lastFrame = nowMs;
      }
      if (nowMs - lastResync >= resyncEveryMs) {
        refresh();
        lastResync = nowMs;
      }
      await sleep(1_000 - (Date.now() % 1_000), undefined, {
        signal: opts.signal,
      }).catch(() => undefined);
    }
  } catch (err) {
    if (!opts.signal.aborted) throw err;
  } finally {
    stopped = true;
    // like the engine on a clean stop: close what is open, and let the cameras read as offline
    try {
      const now = Date.now();
      const closes: Message[] = [];
      for (const camera of cameras) {
        const state = states.get(camera.id);
        if (state) closes.push(...closeOpen(state, camera, now, 'engine_stop'));
      }
      if (redis.status === 'ready') {
        await send(closes);
        if (cameras.length > 0) {
          await redis.del(...cameras.map((c) => statusKey(c.id)));
        }
      }
    } catch (err) {
      log.warn(`could not close cleanly: ${(err as Error).message}`);
    }
    subscriber.disconnect();
    redis.disconnect();
  }
}
