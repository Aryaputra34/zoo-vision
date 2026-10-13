import { randomBytes } from 'node:crypto';
import { createValidator } from '@zoo-vision/contracts';
import Redis from 'ioredis';

/** A stream message as JSON (see packages/contracts/envelope/message.schema.json). */
export type Msg = Record<string, unknown>;

/** The camera every builder uses unless `over` names another. Seed it before ingesting. */
const DEFAULT_CAMERA = 'cam_a';

const validator = createValidator();
const hex32 = () => randomBytes(16).toString('hex');

/** Returns `msg`, or throws when it is not a valid message: the builders only make valid fixtures. */
function valid(msg: Msg): Msg {
  const result = validator.validateMessage(msg);
  if (!result.ok) {
    throw new Error(`invalid test message: ${JSON.stringify(result.errors)}`);
  }
  return msg;
}

const envelope = (useCase: string) => ({
  cameraId: DEFAULT_CAMERA,
  useCase,
  schemaVersion: 1,
  configVersion: null,
  time: '2026-10-09T10:00:00.000Z',
});

/** A cashier_presence `cashier_unattended` event with a fresh id. */
export const eventMsg = (over: Msg = {}): Msg =>
  valid({
    message: 'event',
    ...envelope('cashier_presence'),
    id: `evt_${hex32()}`,
    type: 'cashier_unattended',
    severity: 'warning',
    snapshotPath: null,
    data: { absentSec: 12 },
    ...over,
  });

/** A restaurant_table `table_session` open with a fresh session id. */
export const openMsg = (over: Msg = {}): Msg =>
  valid({
    message: 'interval_open',
    ...envelope('restaurant_table'),
    sessionId: `ses_${hex32()}`,
    kind: 'table_session',
    subjectId: 'T1',
    data: { tableName: 'Table 1' },
    ...over,
  });

/** Closes a restaurant_table `table_session`; pass the open's `sessionId`. */
export const closeMsg = (over: Msg = {}): Msg =>
  valid({
    message: 'interval_close',
    ...envelope('restaurant_table'),
    time: '2026-10-09T10:05:00.000Z',
    sessionId: `ses_${hex32()}`,
    kind: 'table_session',
    endReason: 'ended',
    data: {},
    ...over,
  });

/** A cashier_presence `queue_length` metric for the minute 10:00. */
export const metricMsg = (over: Msg = {}): Msg =>
  valid({
    message: 'metric',
    ...envelope('cashier_presence'),
    name: 'queue_length',
    value: 2.5,
    ...over,
  });

/** The `system` event an engine of `group` sends when it starts. */
export const engineStarted = (
  group: string,
  timeIso = '2026-10-09T10:00:00.000Z',
): Msg =>
  valid({
    message: 'event',
    ...envelope('system'),
    cameraId: null,
    time: timeIso,
    id: `evt_${hex32()}`,
    type: 'engine_started',
    severity: 'info',
    snapshotPath: null,
    data: { bootId: hex32(), engineGroup: group },
  });

/** XADDs `msg` (JSON-encoded unless already a string) to `events` the way the engine does. */
export async function xadd(msg: Msg | string): Promise<string> {
  const redis = new Redis(process.env.REDIS_URL as string);
  try {
    const id = await redis.xadd(
      'events',
      'MAXLEN',
      '~',
      1000000,
      '*',
      'msg',
      typeof msg === 'string' ? msg : JSON.stringify(msg),
    );
    return id as string;
  } finally {
    await redis.quit();
  }
}
