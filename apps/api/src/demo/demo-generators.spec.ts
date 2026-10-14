import { createValidator, loadRegistry } from '@zoo-vision/contracts';
import type { EngineCamera } from '../engine-internal/engine-cameras.service';
import { DEMO_CAMERAS } from './demo-cameras';
import {
  type DemoState,
  historyMessages,
  liveMessages,
  liveStatusFields,
  type Message,
  newDemoState,
  snapshotPath,
} from './demo-generators';
import { mulberry32 } from './rng';

const TZ = 'Asia/Jakarta';
const FROM = new Date('2026-10-13T00:00:00+07:00');
const TO = new Date('2026-10-14T00:00:00+07:00');
const validator = createValidator();
const registry = loadRegistry();

const cameras: EngineCamera[] = DEMO_CAMERAS.map((c) => ({
  id: c.id,
  name: c.name,
  useCase: c.useCase,
  version: 1,
  schemaVersion: registry.useCases.get(c.useCase)?.schemaVersion ?? 1,
  settings: validator.withDefaults(c.useCase, c.settings) as Record<
    string,
    unknown
  >,
  sourceUrl: '',
  targetFps: 5,
  nxCameraId: null,
  model: { path: 'demo.onnx', imgsz: 640 },
}));
const camera = (useCase: string): EngineCamera => {
  const found = cameras.find((c) => c.useCase === useCase);
  if (!found) throw new Error(`no demo camera for ${useCase}`);
  return found;
};

const day = (c: EngineCamera, seed = 42): Message[] =>
  historyMessages(c, FROM, TO, mulberry32(seed), TZ);

/** Minutes after local midnight (Asia/Jakarta is UTC+7 all year). */
const localMinutes = (iso: string): number => {
  const d = new Date(iso);
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 7 * 60) % (24 * 60);
};

describe('demo generators', () => {
  it('one day of history for each demo camera: every message passes validateMessage', () => {
    for (const c of cameras) {
      const messages = day(c);
      expect(messages.length).toBeGreaterThan(100);
      const bad = messages
        .map((m) => ({ m, r: validator.validateMessage(m) }))
        .filter(({ r }) => !r.ok)
        .slice(0, 3)
        .map(
          ({ m, r }) => `${c.id}: ${JSON.stringify(r)} ${JSON.stringify(m)}`,
        );
      expect(bad).toEqual([]);
    }
  });

  it('the same seed gives identical messages', () => {
    for (const c of cameras) {
      expect(JSON.stringify(day(c, 7))).toBe(JSON.stringify(day(c, 7)));
    }
    const gate = camera('vehicle_gate');
    expect(JSON.stringify(day(gate, 7))).not.toBe(JSON.stringify(day(gate, 8)));
  });

  it('vehicle_gate: 1,000–1,400 crossings in a day; most ENTRY crossings before 12:00 local', () => {
    const crossings = day(camera('vehicle_gate')).filter(
      (m) => m.type === 'vehicle_crossing',
    );
    expect(crossings.length).toBeGreaterThanOrEqual(1000);
    expect(crossings.length).toBeLessThanOrEqual(1400);
    const entries = crossings.filter(
      (m) => (m.data as { direction: string }).direction === 'ENTRY',
    );
    const morning = entries.filter(
      (m) => localMinutes(m.time as string) < 12 * 60,
    );
    expect(morning.length / entries.length).toBeGreaterThan(0.6);
    const exits = crossings.filter(
      (m) => (m.data as { direction: string }).direction === 'EXIT',
    );
    const afternoon = exits.filter(
      (m) => localMinutes(m.time as string) >= 12 * 60,
    );
    expect(afternoon.length / exits.length).toBeGreaterThan(0.6);
  });

  it('every interval_open has its interval_close later, both inside [from, to)', () => {
    let pairs = 0;
    for (const c of cameras) {
      const messages = day(c);
      const opens = new Map<string, Message>();
      for (const m of messages) {
        if (m.message === 'interval_open') {
          opens.set(m.sessionId as string, m);
        }
      }
      const closes = messages.filter((m) => m.message === 'interval_close');
      expect(closes.length).toBe(opens.size);
      for (const close of closes) {
        const open = opens.get(close.sessionId as string);
        expect(open).toBeDefined();
        const start = new Date(open?.time as string).getTime();
        const end = new Date(close.time as string).getTime();
        expect(end).toBeGreaterThan(start);
        expect(start).toBeGreaterThanOrEqual(FROM.getTime());
        expect(end).toBeLessThan(TO.getTime());
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(10); // cashier desks and restaurant tables
  });

  it('a window that cuts a session in two drops it: no open without its close', () => {
    const table = camera('restaurant_table');
    const from = new Date('2026-10-13T10:00:00+07:00');
    const to = new Date('2026-10-13T12:00:00+07:00');
    const messages = historyMessages(table, from, to, mulberry32(42), TZ);
    const opens = messages.filter((m) => m.message === 'interval_open');
    const closes = messages.filter((m) => m.message === 'interval_close');
    expect(opens.length).toBeGreaterThan(0);
    expect(closes.map((m) => m.sessionId).sort()).toEqual(
      opens.map((m) => m.sessionId).sort(),
    );
    for (const m of messages) {
      const t = new Date(m.time as string).getTime();
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThan(to.getTime());
    }
  });

  it('no message falls outside 08:00–17:00 Asia/Jakarta', () => {
    for (const c of cameras) {
      for (const m of day(c)) {
        const minutes = localMinutes(m.time as string);
        expect(minutes).toBeGreaterThanOrEqual(8 * 60);
        expect(minutes).toBeLessThanOrEqual(17 * 60);
      }
    }
  });

  it('liveMessages gives nothing on its first call, then each message once, in order, all valid', () => {
    for (const c of cameras) {
      const state = newDemoState();
      const rng = mulberry32(5);
      const start = new Date('2026-10-14T09:00:00+07:00').getTime();
      expect(liveMessages(c, new Date(start), state, rng, TZ)).toEqual([]);
      const seen: Message[] = [];
      for (let s = 1; s <= 7200; s += 1) {
        seen.push(
          ...liveMessages(c, new Date(start + s * 1000), state, rng, TZ),
        );
      }
      expect(seen.length).toBeGreaterThan(0);
      const invalid = seen.filter((m) => !validator.validateMessage(m).ok);
      expect(invalid.slice(0, 2)).toEqual([]);
      // each message once: an event by id, an interval message by session and kind, a metric by name and minute
      const keys = seen.map((m) =>
        m.message === 'event'
          ? String(m.id)
          : m.message === 'metric'
            ? `${String(m.name)}@${String(m.time)}`
            : `${String(m.sessionId)}:${String(m.message)}`,
      );
      expect(new Set(keys).size).toBe(seen.length);
      const times = seen.map((m) => new Date(m.time as string).getTime());
      // events and intervals arrive in time order; a metric's time is its minute start
      const ordered = seen
        .filter((m) => m.message !== 'metric')
        .map((m) => new Date(m.time as string).getTime());
      expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
      expect(Math.min(...times)).toBeGreaterThanOrEqual(start);
    }
  });

  it('a snapshot lives under its camera and its local day: <camera>/<YYYY-MM-DD>/<eventId>.jpg', () => {
    // 23:30 UTC is already the next day in Jakarta
    expect(
      snapshotPath(
        'demo_vehicle_gate',
        '2026-10-13T23:30:00.000Z',
        'evt_0123456789abcdef0123456789abcdef',
        TZ,
      ),
    ).toBe(
      'demo_vehicle_gate/2026-10-14/evt_0123456789abcdef0123456789abcdef.jpg',
    );
  });

  it('liveStatusFields(...).live passes validateLive for each use case', () => {
    for (const c of cameras) {
      const state = newDemoState();
      const rng = mulberry32(5);
      const start = new Date('2026-10-14T09:00:00+07:00').getTime();
      let now = new Date(start);
      for (let s = 0; s <= 5400; s += 1) {
        now = new Date(start + s * 1000);
        liveMessages(c, now, state, rng, TZ);
      }
      const fields = liveStatusFields(c, state, 'a'.repeat(32), now);

      expect(fields).toMatchObject({
        state: 'running',
        fps: '5.0',
        appliedVersion: '1',
        engineGroup: 'demo',
        useCase: c.useCase,
        restarts: '0',
      });
      const live = JSON.parse(fields.live) as unknown;
      expect(validator.validateLive(c.useCase, live)).toEqual({ ok: true });
      expect(Object.keys(live as object).length).toBeGreaterThan(0);
    }
  });

  describe('what the live feed has sent stays consistent', () => {
    const at = (iso: string) => new Date(iso).getTime();
    type Sent = { tick: number; msg: Message };

    /** Calls liveMessages every 5 s from `from` to `to` (inclusive), like the feed's loop. */
    function drive(
      c: EngineCamera,
      state: DemoState,
      rng: () => number,
      from: number,
      to: number,
      sent: Sent[],
      opts: {
        silent?: [number, number][];
        cameraAt?: (ms: number) => EngineCamera;
      } = {},
    ): void {
      for (let t = from; t <= to; t += 5_000) {
        const silent = (opts.silent ?? []).some(([a, b]) => t >= a && t < b);
        const camera = opts.cameraAt?.(t) ?? c;
        for (const msg of liveMessages(
          camera,
          new Date(t),
          state,
          rng,
          TZ,
          silent,
        )) {
          sent.push({ tick: t, msg });
        }
      }
    }

    /** Closes whose open was never sent before them. */
    const orphanCloses = (sent: Sent[]): string[] => {
      const opened = new Set<string>();
      const bad: string[] = [];
      for (const { msg } of sent) {
        if (msg.message === 'interval_open') {
          opened.add(msg.sessionId as string);
        }
        if (
          msg.message === 'interval_close' &&
          !opened.has(msg.sessionId as string)
        ) {
          bad.push(msg.sessionId as string);
        }
      }
      return bad;
    };
    /** Opens that were sent and never closed. */
    const leftOpen = (sent: Sent[]): string[] => {
      const open = new Set<string>();
      for (const { msg } of sent) {
        if (msg.message === 'interval_open') open.add(msg.sessionId as string);
        if (msg.message === 'interval_close') {
          open.delete(msg.sessionId as string);
        }
      }
      return [...open];
    };
    const withIntervals = ['restaurant_table', 'cashier_presence'];

    it('started at midday: no interval_close for an open that was never sent', () => {
      for (const useCase of withIntervals) {
        const c = camera(useCase);
        const sent: Sent[] = [];
        drive(
          c,
          newDemoState(),
          mulberry32(5),
          at('2026-10-14T12:00:00+07:00'),
          at('2026-10-14T14:00:00+07:00'),
          sent,
        );
        expect({ useCase, orphans: orphanCloses(sent) }).toEqual({
          useCase,
          orphans: [],
        });
      }
    });

    it('a silence ends the open intervals (engine_stop) at its start and drops what falls inside it', () => {
      const c = camera('restaurant_table');
      const sent: Sent[] = [];
      const silence: [number, number][] = [
        [at('2026-10-14T12:30:00+07:00'), at('2026-10-14T12:33:00+07:00')],
        [at('2026-10-14T13:10:00+07:00'), at('2026-10-14T13:12:00+07:00')],
      ];
      drive(
        c,
        newDemoState(),
        mulberry32(5),
        at('2026-10-14T12:00:00+07:00'),
        at('2026-10-14T14:00:00+07:00'),
        sent,
        { silent: silence },
      );

      expect(orphanCloses(sent)).toEqual([]);
      const stops = sent.filter(({ msg }) => msg.endReason === 'engine_stop');
      expect(stops.length).toBeGreaterThan(0);
      for (const { tick, msg } of stops) {
        // sent in the first silent tick, stamped at the last tick the camera was alive
        expect(silence.some(([a]) => tick === a)).toBe(true);
        expect(new Date(msg.time as string).getTime()).toBeLessThan(tick);
      }
      // nothing at all is sent while it is silent, apart from those closes
      const inside = sent.filter(({ tick }) =>
        silence.some(([a, b]) => tick >= a && tick < b),
      );
      expect(inside.every(({ msg }) => msg.endReason === 'engine_stop')).toBe(
        true,
      );
    });

    it('a new local day closes what the old plan left open, at the last tick the camera was alive', () => {
      const c = camera('restaurant_table');
      const state = newDemoState();
      const rng = mulberry32(5);
      const sent: Sent[] = [];
      const lastAlive = at('2026-10-14T12:00:00+07:00');
      drive(c, state, rng, at('2026-10-14T09:00:00+07:00'), lastAlive, sent);
      expect(state.open.size).toBeGreaterThan(0);

      // the laptop slept overnight
      drive(
        c,
        state,
        rng,
        at('2026-10-15T09:00:00+07:00'),
        at('2026-10-15T17:30:00+07:00'),
        sent,
      );

      const stops = sent.filter(({ msg }) => msg.endReason === 'engine_stop');
      expect(stops.length).toBeGreaterThan(0);
      expect(
        stops.every(
          ({ msg }) => new Date(msg.time as string).getTime() === lastAlive,
        ),
      ).toBe(true);
      expect(orphanCloses(sent)).toEqual([]);
      expect(leftOpen(sent)).toEqual([]);
      expect(state.open.size).toBe(0);
    });

    it('a whole opening day leaves nothing open at 17:00, for every use case', () => {
      for (const c of cameras) {
        const sent: Sent[] = [];
        drive(
          c,
          newDemoState(),
          mulberry32(9),
          at('2026-10-14T07:59:00+07:00'),
          at('2026-10-14T17:05:00+07:00'),
          sent,
        );
        expect({ id: c.id, orphans: orphanCloses(sent) }).toEqual({
          id: c.id,
          orphans: [],
        });
        expect({ id: c.id, open: leftOpen(sent) }).toEqual({
          id: c.id,
          open: [],
        });
      }
    });

    it('configVersion and schemaVersion follow the camera as it is when a message is sent', () => {
      const c = camera('vehicle_gate');
      const switchAt = at('2026-10-14T10:00:00+07:00');
      const v2: EngineCamera = { ...c, version: 2, schemaVersion: 1 };
      const sent: Sent[] = [];
      drive(
        c,
        newDemoState(),
        mulberry32(5),
        at('2026-10-14T09:00:00+07:00'),
        at('2026-10-14T11:00:00+07:00'),
        sent,
        { cameraAt: (t) => (t >= switchAt ? v2 : c) },
      );

      const before = sent.filter(({ tick }) => tick < switchAt);
      const after = sent.filter(({ tick }) => tick >= switchAt);
      expect(before.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);
      expect(before.every(({ msg }) => msg.configVersion === 1)).toBe(true);
      expect(after.every(({ msg }) => msg.configVersion === 2)).toBe(true);
    });
  });
});
