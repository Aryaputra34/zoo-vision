import type { Event, Interval } from '../generated/prisma/client';
import type { EvidenceReason, EvidenceStatus } from '../generated/prisma/enums';
import { mediamtxPaths } from '../mediamtx/paths';

export type EventRow = {
  id: string;
  time: string;
  cameraId: string | null;
  cameraName: string | null;
  useCase: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  configVersion: number | null;
  data: object;
  snapshotUrl: string | null;
  clipUrl: string | null;
  evidence: { status: EvidenceStatus; reason: EvidenceReason } | null;
};

export type IntervalRow = {
  id: string;
  cameraId: string;
  cameraName: string;
  useCase: string;
  kind: string;
  subjectId: string | null;
  start: string;
  end: string | null;
  endReason: string | null;
  durationSec: number | null;
  data: object;
};

export type Page<T> = { rows: T[]; nextCursor: string | null };

/** What {@link eventRow} reads: the event, the camera columns the clip link needs, and its evidence row. */
export type EventWithCamera = Event & {
  camera:
    ({ name: string } & Omit<Parameters<typeof mediamtxPaths>[0], 'id'>) | null;
  evidence: { status: EvidenceStatus; reason: EvidenceReason } | null;
};

export type IntervalWithCamera = Interval & { camera: { name: string } };

/** The relations {@link EventWithCamera} needs, for Prisma's `include`. */
export const EVENT_INCLUDE = {
  camera: {
    select: {
      name: true,
      sourceType: true,
      subStreamUrlEnc: true,
      recordingEnabled: true,
      recordingStream: true,
      inferenceStream: true,
    },
  },
  evidence: { select: { status: true, reason: true } },
} as const;

export const INTERVAL_CAMERA = { camera: { select: { name: true } } } as const;

/** The API's view of an Event: URLs for the media endpoints instead of file paths. */
export function eventRow(e: EventWithCamera): EventRow {
  return {
    id: e.id,
    time: e.time.toISOString(),
    cameraId: e.cameraId,
    cameraName: e.camera?.name ?? null,
    useCase: e.useCase,
    type: e.type,
    severity: e.severity,
    configVersion: e.configVersion,
    data: e.data as object,
    snapshotUrl: e.snapshotPath
      ? `/media/snapshots/${e.snapshotPath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
      : null,
    // the clip itself can still be gone: /media/clips/:id answers RECORDING_NOT_AVAILABLE then
    clipUrl:
      e.evidence?.status === 'KEPT' ||
      (e.camera &&
        e.cameraId &&
        mediamtxPaths({ ...e.camera, id: e.cameraId })?.recorded)
        ? `/media/clips/${encodeURIComponent(e.id)}`
        : null,
    evidence: e.evidence,
  };
}

export function intervalRow(i: IntervalWithCamera): IntervalRow {
  return {
    id: i.id,
    cameraId: i.cameraId,
    cameraName: i.camera.name,
    useCase: i.useCase,
    kind: i.kind,
    subjectId: i.subjectId,
    start: i.start.toISOString(),
    end: i.end?.toISOString() ?? null,
    endReason: i.endReason,
    durationSec: i.end ? (i.end.getTime() - i.start.getTime()) / 1000 : null,
    data: i.data as object,
  };
}
