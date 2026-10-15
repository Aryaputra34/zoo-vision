import { randomBytes } from 'node:crypto';
import { ownerQuery } from '../setup/db';

/**
 * Report test data, inserted as zoo_owner (so no app is needed and a 200,000-row table is one
 * statement). Times are anything Postgres reads as a timestamptz, e.g. ISO strings.
 */

/** Inserts a camera. Defaults: a FILE camera, use case cashier_presence, recording on (FILE has no clips). */
export async function addCamera(
  id: string,
  opts: {
    name?: string;
    useCase?: string;
    sourceType?: 'FILE' | 'RTSP';
    recordingPath?: string | null;
    recordingEnabled?: boolean;
    clipBeforeSec?: number;
    clipAfterSec?: number;
  } = {},
): Promise<void> {
  await ownerQuery(
    `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "recordingPath",
                           "recordingEnabled", "clipBeforeSec", "clipAfterSec", "activeVersion", "updatedAt")
     VALUES ($1, $2, $3, $8::"SourceType", 'enc', $4, $5, $6, $7, 1, now())`,
    id,
    opts.name ?? id,
    opts.useCase ?? 'cashier_presence',
    opts.recordingPath ?? null,
    opts.recordingEnabled ?? true,
    opts.clipBeforeSec ?? 15,
    opts.clipAfterSec ?? 15,
    opts.sourceType ?? 'FILE',
  );
}

export type EventSeed = {
  id?: string;
  time: string;
  cameraId: string | null;
  useCase: string;
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  snapshotPath?: string | null;
  configVersion?: number | null;
};

/** Inserts one Event and returns its id. */
export async function addEvent(e: EventSeed): Promise<string> {
  const id = e.id ?? `evt_${randomBytes(8).toString('hex')}`;
  await ownerQuery(
    `INSERT INTO "Event" ("id", "time", "cameraId", "useCase", "type", "severity", "configVersion",
                          "schemaVersion", "snapshotPath", "data")
     VALUES ($1, $2, $3, $4, $5, $6::"Severity", $7, 1, $8, $9::jsonb)`,
    id,
    e.time,
    e.cameraId,
    e.useCase,
    e.type,
    e.severity ?? 'info',
    e.configVersion ?? null,
    e.snapshotPath ?? null,
    JSON.stringify(e.data ?? {}),
  );
  return id;
}

export type IntervalSeed = {
  id?: string;
  cameraId: string;
  useCase: string;
  kind: string;
  subjectId?: string | null;
  start: string;
  /** null (the default) is an open interval. */
  end?: string | null;
  endReason?: string | null;
  data?: Record<string, unknown>;
};

/** Inserts one Interval and returns its id. */
export async function addInterval(i: IntervalSeed): Promise<string> {
  const id = i.id ?? `ses_${randomBytes(8).toString('hex')}`;
  await ownerQuery(
    `INSERT INTO "Interval" ("id", "cameraId", "useCase", "kind", "subjectId", "start", "end", "endReason",
                             "schemaVersion", "data")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9::jsonb)`,
    id,
    i.cameraId,
    i.useCase,
    i.kind,
    i.subjectId ?? null,
    i.start,
    i.end ?? null,
    i.endReason ?? null,
    JSON.stringify(i.data ?? {}),
  );
  return id;
}

export type MetricSeed = {
  cameraId: string;
  useCase: string;
  name: string;
  minute: string;
  value: number;
};

/** Inserts one Metric row. */
export async function addMetric(m: MetricSeed): Promise<void> {
  await ownerQuery(
    `INSERT INTO "Metric" ("cameraId", "useCase", "name", "minute", "value") VALUES ($1, $2, $3, $4, $5)`,
    m.cameraId,
    m.useCase,
    m.name,
    m.minute,
    m.value,
  );
}
