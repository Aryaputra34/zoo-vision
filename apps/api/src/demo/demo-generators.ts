import type { EngineCamera } from '../engine-internal/engine-cameras.service';
import { between, hex, intBetween, type Rng, weighted } from './rng';

/** A stream message (see packages/contracts/envelope/message.schema.json). */
export type Message = Record<string, unknown>;
type Timed = { t: number; msg: Message };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Opening hours, local: nothing happens outside them. */
const OPEN = 8 * HOUR;
const CLOSE = 17 * HOUR;

// ---------------------------------------------------------------------------------------------
// Local time (the site timezone; Asia/Jakarta has no daylight saving, but any IANA name works)

function zoneOffsetMs(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour'),
    n('minute'),
    n('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight of the day containing `ms`. */
export function localDayStart(ms: number, tz: string): number {
  let guess = ms;
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMs(tz, guess);
    guess = Math.floor((ms + offset) / DAY) * DAY - offset;
  }
  return guess;
}

/** `YYYY-MM-DD` of the local day containing `ms`. */
export function localDate(ms: number, tz: string): string {
  return new Date(ms + zoneOffsetMs(tz, ms)).toISOString().slice(0, 10);
}

/** Where a live event's snapshot is written, relative to the snapshot folder. */
export function snapshotPath(
  cameraId: string,
  timeIso: string,
  eventId: string,
  tz: string,
): string {
  return `${cameraId}/${localDate(new Date(timeIso).getTime(), tz)}/${eventId}.jpg`;
}

// ---------------------------------------------------------------------------------------------
// Message builders

const iso = (ms: number) => new Date(ms).toISOString();

const envelope = (camera: EngineCamera, ms: number) => ({
  cameraId: camera.id,
  useCase: camera.useCase,
  schemaVersion: camera.schemaVersion,
  configVersion: camera.version,
  time: iso(ms),
});

const event = (
  camera: EngineCamera,
  rng: Rng,
  ms: number,
  type: string,
  severity: 'info' | 'warning' | 'critical',
  data: Record<string, unknown>,
): Timed => ({
  t: ms,
  msg: {
    message: 'event',
    ...envelope(camera, ms),
    id: `evt_${hex(rng, 32)}`,
    type,
    severity,
    snapshotPath: null,
    data,
  },
});

/** An interval's open and close messages (the close carries no data: it merges into the open's). */
function interval(
  camera: EngineCamera,
  rng: Rng,
  kind: string,
  subjectId: string | null,
  openMs: number,
  closeMs: number,
  data: Record<string, unknown>,
): Timed[] {
  const sessionId = `ses_${hex(rng, 32)}`;
  return [
    {
      t: openMs,
      msg: {
        message: 'interval_open',
        ...envelope(camera, openMs),
        sessionId,
        kind,
        subjectId,
        data,
      },
    },
    {
      t: closeMs,
      msg: {
        message: 'interval_close',
        ...envelope(camera, closeMs),
        sessionId,
        kind,
        endReason: 'ended',
        data: {},
      },
    },
  ];
}

const metric = (
  camera: EngineCamera,
  minuteMs: number,
  name: string,
  value: number,
): Timed => ({
  t: minuteMs,
  msg: {
    message: 'metric',
    ...envelope(camera, minuteMs),
    name,
    value,
  },
});

// ---------------------------------------------------------------------------------------------
// One local day of activity per use case

/** A smooth bump of height 1 centred on `centreMin` (minutes after midnight). */
const bump = (minutes: number, centreMin: number, widthMin: number) =>
  Math.exp(-0.5 * ((minutes - centreMin) / widthMin) ** 2);

const minutesOfDay = (t: number, dayStart: number) => (t - dayStart) / MINUTE;

function vehicleDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const out: Timed[] = [];
  // hourly weights from 08:00 to 17:00: ENTRY peaks 08–10, EXIT peaks 15–17
  const entry = [4, 4, 2, 1.5, 1, 1, 0.8, 0.5, 0.3];
  const exit = [0.3, 0.5, 0.8, 1, 1, 1.5, 2, 4, 4];
  const total = Math.round(between(rng, 1100, 1300));
  let tracker = 1;
  for (let i = 0; i < total; i += 1) {
    const direction = rng() < 0.5 ? 'ENTRY' : 'EXIT';
    const weights = direction === 'ENTRY' ? entry : exit;
    const hour = weighted(
      rng,
      weights.map((w, h) => [h, w] as const),
    );
    const t = dayStart + OPEN + (hour + rng()) * HOUR;
    const plate = `B ${intBetween(rng, 1000, 9999)} ${[0, 1, 2]
      .map(() => String.fromCharCode(65 + intBetween(rng, 0, 25)))
      .join('')}`;
    out.push(
      event(camera, rng, t, 'vehicle_crossing', 'info', {
        direction,
        vehicleType: weighted(rng, [
          ['car', 70],
          ['motorcycle', 15],
          ['bus', 10],
          ['truck', 5],
        ]),
        plate,
        plateValid: rng() < 0.92,
        ocrConfidence: Math.round(between(rng, 0.7, 0.99) * 100) / 100,
        trackerId: tracker++,
      }),
    );
  }
  return out;
}

function horseDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const out: Timed[] = [];
  const returns: number[] = [];
  const departures: number[] = [];
  let tracker = 1;
  for (let hour = 9; hour < 16; hour += 1) {
    const rides = intBetween(rng, 22, 28);
    for (let i = 0; i < rides; i += 1) {
      const departed = dayStart + hour * HOUR + rng() * HOUR;
      const back = departed + between(rng, 8, 12) * MINUTE;
      const trackerId = tracker++;
      departures.push(departed);
      returns.push(back);
      out.push(
        event(camera, rng, departed, 'horse_crossing', 'info', {
          direction: 'DEPARTURE',
          trackerId,
        }),
        event(camera, rng, back, 'horse_crossing', 'info', {
          direction: 'RETURN',
          trackerId,
        }),
      );
    }
  }
  for (let m = dayStart + OPEN; m < dayStart + CLOSE; m += MINUTE) {
    const away =
      departures.filter((d) => d <= m).length -
      returns.filter((r) => r <= m).length;
    out.push(metric(camera, m, 'active_horses', Math.max(0, away)));
  }
  return out;
}

function cashierDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const out: Timed[] = [];
  const desks: [number, number][] = [];
  const count = intBetween(rng, 4, 8);
  const slot = (CLOSE - OPEN - 30 * MINUTE) / count;
  for (let i = 0; i < count; i += 1) {
    const duration = between(rng, 2, 15) * MINUTE;
    const open =
      dayStart + OPEN + i * slot + rng() * Math.max(0, slot - duration);
    desks.push([open, open + duration]);
    out.push(
      ...interval(
        camera,
        rng,
        'desk_unattended',
        null,
        open,
        open + duration,
        {},
      ),
      event(camera, rng, open + MINUTE, 'cashier_unattended', 'warning', {
        absentSec: 60,
      }),
    );
  }
  for (let i = 0; i < 10; i += 1) {
    out.push(
      event(
        camera,
        rng,
        dayStart + OPEN + rng() * (CLOSE - OPEN),
        'customer_waiting',
        'info',
        { waitingSec: intBetween(rng, 30, 180) },
      ),
    );
  }
  for (let m = dayStart + OPEN; m < dayStart + CLOSE; m += MINUTE) {
    const lunch = bump(minutesOfDay(m, dayStart), 12.75 * 60, 70);
    const queue = Math.round(0.5 + 3.5 * lunch + (rng() - 0.5) * 2.4);
    const unattended = desks.some(([a, b]) => m >= a && m < b);
    out.push(
      metric(camera, m, 'queue_length', Math.min(6, Math.max(0, queue))),
      metric(camera, m, 'clerk_count', unattended ? 0 : rng() < 0.15 ? 2 : 1),
    );
  }
  return out;
}

function counterDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const out: Timed[] = [];
  const max = Number(camera.settings.max_capacity ?? 60);
  const warning = Number(camera.settings.warning_capacity ?? 45);
  const peak = intBetween(rng, 50, 66);
  let level = 0; // 0 none, 1 near the warning capacity, 2 at the maximum
  for (let m = dayStart + OPEN; m < dayStart + CLOSE; m += MINUTE) {
    const minutes = minutesOfDay(m, dayStart);
    const curve = 0.12 + 0.88 * bump(minutes, 12.75 * 60, 68);
    const occupancy = Math.max(0, Math.round(peak * curve + (rng() - 0.5) * 5));
    out.push(metric(camera, m, 'occupancy', occupancy));
    const rank = occupancy >= max ? 2 : occupancy >= warning ? 1 : 0;
    if (rank > level) {
      // one alert on each rise to a higher level
      out.push(
        event(
          camera,
          rng,
          m,
          'capacity_alert',
          rank === 2 ? 'critical' : 'warning',
          {
            occupancy,
            maxCapacity: max,
            warningCapacity: warning,
            level: rank === 2 ? 'full' : 'near_limit',
          },
        ),
      );
      level = rank;
    } else if (occupancy < (level === 2 ? max : warning) - 3) {
      level = rank; // re-armed once occupancy is 3 below the threshold
    }
  }
  return out;
}

type TableSpec = { id: string; name: string; capacity: number };
function tablesOf(camera: EngineCamera): TableSpec[] {
  const settings = camera.settings as {
    tables?: unknown;
    table_monitoring?: { tables?: unknown };
  };
  const raw = settings.tables ?? settings.table_monitoring?.tables;
  if (!Array.isArray(raw)) return [];
  return raw.map((t: { id: string; name?: string; capacity?: number }) => ({
    id: t.id,
    name: t.name ?? t.id,
    capacity: t.capacity ?? 4,
  }));
}

function tableDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const out: Timed[] = [];
  const tables = tablesOf(camera);
  const sessions: [number, number][] = [];
  for (const table of tables) {
    let at = dayStart + OPEN + rng() * 45 * MINUTE;
    for (;;) {
      const open = Math.floor(at / 1000) * 1000;
      const close = Math.min(
        open + between(rng, 20, 70) * MINUTE,
        dayStart + CLOSE - 1000,
      );
      if (close - open < 5 * MINUTE) break;
      sessions.push([open, close]);
      out.push(
        ...interval(camera, rng, 'table_session', table.id, open, close, {
          tableName: table.name,
        }),
      );
      at = close + between(rng, 5, 30) * MINUTE;
    }
  }
  for (let m = dayStart + OPEN; m < dayStart + CLOSE; m += MINUTE) {
    const occupied = sessions.filter(([a, b]) => m >= a && m < b).length;
    out.push(
      metric(camera, m, 'occupied_tables', occupied),
      metric(
        camera,
        m,
        'table_occupancy_pct',
        tables.length === 0
          ? 0
          : Math.round((occupied / tables.length) * 1000) / 10,
      ),
    );
  }
  return out;
}

function planDay(camera: EngineCamera, dayStart: number, rng: Rng): Timed[] {
  const make: Record<
    string,
    (c: EngineCamera, start: number, r: Rng) => Timed[]
  > = {
    vehicle_gate: vehicleDay,
    horse_riding: horseDay,
    cashier_presence: cashierDay,
    restaurant_counter: counterDay,
    restaurant_table: tableDay,
  };
  const items = make[camera.useCase]?.(camera, dayStart, rng) ?? [];
  // a stable order: by time, and an interval's open before anything else at the same instant
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.t - b.item.t || a.i - b.i)
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------------------------
// History

/**
 * The camera's activity in [from, to), in time order. An interval whose open and close are not both
 * inside the window is left out entirely, so the history never holds a half-open interval.
 */
export function historyMessages(
  camera: EngineCamera,
  from: Date,
  to: Date,
  rng: Rng,
  tz: string,
): Message[] {
  const items: Timed[] = [];
  for (
    let day = localDayStart(from.getTime(), tz);
    day < to.getTime();
    day = localDayStart(day + 30 * HOUR, tz)
  ) {
    items.push(...planDay(camera, day, rng));
  }
  const inside = items.filter(
    (i) => i.t >= from.getTime() && i.t < to.getTime(),
  );
  const complete = new Set<string>();
  const seen = new Map<string, number>();
  for (const { msg } of inside) {
    if (msg.message === 'interval_open' || msg.message === 'interval_close') {
      const id = msg.sessionId as string;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (seen.get(id) === 2) complete.add(id);
    }
  }
  return inside
    .filter(
      ({ msg }) =>
        !('sessionId' in msg) || complete.has(msg.sessionId as string),
    )
    .map(({ msg }) => msg);
}

// ---------------------------------------------------------------------------------------------
// Live

export type DemoState = {
  lastNow: number | null;
  planDate: string | null;
  items: Timed[];
  /** The next plan item not yet due (the plan is in time order). */
  cursor: number;
  /** Session id -> the interval_open message, until its close is emitted. */
  open: Map<string, Message>;
  counters: {
    in: number;
    out: number;
    departures: number;
    returns: number;
    /** Sessions opened per table today. */
    sessions: Map<string, number>;
  };
  /** The latest value of each metric. */
  metrics: Map<string, number>;
  deskOpen: boolean;
};

export function newDemoState(): DemoState {
  return {
    lastNow: null,
    planDate: null,
    items: [],
    cursor: 0,
    open: new Map(),
    counters: { in: 0, out: 0, departures: 0, returns: 0, sessions: new Map() },
    metrics: new Map(),
    deskOpen: false,
  };
}

function track(state: DemoState, msg: Message): void {
  const data = (msg.data ?? {}) as Record<string, unknown>;
  switch (msg.message) {
    case 'event':
      if (msg.type === 'vehicle_crossing') {
        if (data.direction === 'ENTRY') state.counters.in += 1;
        else state.counters.out += 1;
      } else if (msg.type === 'horse_crossing') {
        if (data.direction === 'DEPARTURE') state.counters.departures += 1;
        else state.counters.returns += 1;
      }
      break;
    case 'interval_open': {
      state.open.set(msg.sessionId as string, msg);
      if (msg.kind === 'desk_unattended') state.deskOpen = true;
      if (msg.kind === 'table_session') {
        const id = String(msg.subjectId);
        state.counters.sessions.set(
          id,
          (state.counters.sessions.get(id) ?? 0) + 1,
        );
      }
      break;
    }
    case 'interval_close':
      state.open.delete(msg.sessionId as string);
      if (msg.kind === 'desk_unattended') state.deskOpen = false;
      break;
    case 'metric':
      state.metrics.set(msg.name as string, msg.value as number);
      break;
    default:
  }
}

/** A gap between two calls longer than this means the feed was not running (a laptop that slept). */
const DOWNTIME_MS = 60_000;

/** The message as the camera is configured when it is sent, not when the day's plan was drawn. */
const stamp = (msg: Message, camera: EngineCamera): Message => ({
  ...msg,
  schemaVersion: camera.schemaVersion,
  configVersion: camera.version,
});

/**
 * Closes every interval this feed has sent and not closed, at `atMs` (never before its open), and
 * forgets them. `engine_stop` is a camera or the feed stopping; `config_change` is the camera leaving
 * the engine group.
 */
export function closeOpen(
  state: DemoState,
  camera: EngineCamera,
  atMs: number,
  reason: 'engine_stop' | 'config_change',
): Message[] {
  const closes = [...state.open.values()].map((open) => ({
    message: 'interval_close',
    cameraId: camera.id,
    useCase: camera.useCase,
    schemaVersion: camera.schemaVersion,
    configVersion: camera.version,
    time: iso(Math.max(atMs, new Date(open.time as string).getTime())),
    sessionId: open.sessionId,
    kind: open.kind,
    endReason: reason,
    data: {},
  }));
  state.open.clear();
  state.deskOpen = false;
  return closes;
}

/**
 * What is due now: the messages of today's plan with time in (the previous call, now]. The first
 * call only starts the clock, so nothing from before the feed started is emitted. A new local day
 * draws a new plan from `rng`.
 *
 * What it returns is consistent with what it returned before: an interval is closed only if its open
 * was sent, and an interval left open when the camera stops (`silent`: the demo's outage; a gap
 * between calls: the feed was not running; a new day) is closed with `engine_stop` at the last
 * tick the camera was alive. While `silent` nothing else is sent.
 */
export function liveMessages(
  camera: EngineCamera,
  now: Date,
  state: DemoState,
  rng: Rng,
  tz: string,
  silent = false,
): Message[] {
  const nowMs = now.getTime();
  const last = state.lastNow ?? nowMs;
  const out: Message[] = [];
  const down = nowMs - last > DOWNTIME_MS;
  const date = localDate(nowMs, tz);

  if (down || state.planDate !== date) {
    out.push(...closeOpen(state, camera, last, 'engine_stop'));
  }
  if (state.planDate !== date) {
    state.planDate = date;
    state.items = planDay(camera, localDayStart(nowMs, tz), rng);
    state.cursor = 0;
    state.counters = newDemoState().counters;
    state.metrics = new Map();
  }
  state.lastNow = nowMs;

  // skip what is not due: before the previous tick, or the whole gap when the feed was not running
  const from = down ? nowMs : last;
  while (
    state.cursor < state.items.length &&
    state.items[state.cursor].t <= from
  ) {
    state.cursor += 1;
  }

  if (silent) {
    out.push(...closeOpen(state, camera, last, 'engine_stop'));
    while (
      state.cursor < state.items.length &&
      state.items[state.cursor].t <= nowMs
    ) {
      state.cursor += 1;
    }
    return out;
  }

  while (
    state.cursor < state.items.length &&
    state.items[state.cursor].t <= nowMs
  ) {
    const { msg } = state.items[state.cursor];
    state.cursor += 1;
    // its open fell in a silence, or before the feed started: a close with no open is not sent
    if (
      msg.message === 'interval_close' &&
      !state.open.has(msg.sessionId as string)
    ) {
      continue;
    }
    const sent = stamp(msg, camera);
    track(state, sent);
    out.push(sent);
  }
  return out;
}

/** The `live` values of the camera's use case, from what the live feed has emitted so far. */
function liveValues(
  camera: EngineCamera,
  state: DemoState,
  now: Date,
): Record<string, unknown> {
  const c = state.counters;
  const metric = (name: string, fallback = 0) =>
    state.metrics.get(name) ?? fallback;
  switch (camera.useCase) {
    case 'vehicle_gate':
      return { inCount: c.in, outCount: c.out, anprEnabled: false };
    case 'horse_riding':
      return {
        activeHorses: Math.max(0, c.departures - c.returns),
        departures: c.departures,
        returns: c.returns,
      };
    case 'cashier_presence':
      return {
        state: state.deskOpen ? 'ABSENT' : 'PRESENT',
        clerkPresent: !state.deskOpen,
        clerkCount: metric('clerk_count', state.deskOpen ? 0 : 1),
        visitorCount: metric('queue_length'),
      };
    case 'restaurant_counter': {
      const occupancy = metric('occupancy');
      return {
        occupancy,
        rawOccupancy: occupancy,
        maxCapacity: Number(camera.settings.max_capacity ?? 60),
        warningCapacity: Number(camera.settings.warning_capacity ?? 45),
        mode: 'area_occupancy',
      };
    }
    case 'restaurant_table': {
      const dwell = (camera.settings.dwell_time ?? {}) as { enabled?: boolean };
      const tables = tablesOf(camera).map((t) => {
        const session = [...state.open.values()].find(
          (m) => m.kind === 'table_session' && m.subjectId === t.id,
        );
        const since = session ? new Date(session.time as string).getTime() : 0;
        return {
          id: t.id,
          name: t.name,
          status: session ? 'OCCUPIED' : 'EMPTY',
          isOccupied: Boolean(session),
          personCount: session ? 1 + (t.id.length % t.capacity) : 0,
          capacity: t.capacity,
          dwellSec: session
            ? Math.max(0, Math.floor((now.getTime() - since) / 1000))
            : 0,
          trackDwellTime: Boolean(dwell.enabled),
          totalSessions: c.sessions.get(t.id) ?? 0,
        };
      });
      const occupied = tables.filter((t) => t.isOccupied).length;
      return {
        totalTables: tables.length,
        occupiedTables: occupied,
        vacantTables: tables.length - occupied,
        occupancyRatePct:
          tables.length === 0
            ? 0
            : Math.round((occupied / tables.length) * 1000) / 10,
        dwellTimeEnabled: Boolean(dwell.enabled),
        tables,
      };
    }
    default:
      return {};
  }
}

/** The fields of the `cam:{id}:status` hash, as the engine writes them (times in epoch milliseconds). */
export function liveStatusFields(
  camera: EngineCamera,
  state: DemoState,
  bootId: string,
  now: Date,
): Record<string, string> {
  const ms = now.getTime();
  return {
    state: 'running',
    fps: '5.0',
    lastFrameAt: String(ms),
    appliedVersion: String(camera.version),
    configError: '',
    useCase: camera.useCase,
    engineGroup: 'demo',
    bootId,
    restarts: '0',
    live: JSON.stringify(liveValues(camera, state, now)),
    updatedAt: String(ms),
  };
}
