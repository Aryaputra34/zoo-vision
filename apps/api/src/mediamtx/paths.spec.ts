import { randomBytes } from 'node:crypto';
import { UrlCipher } from '../cameras/url-cipher';
import type { Camera } from '../generated/prisma/client';
import {
  durationSeconds,
  isManaged,
  mediamtxPaths,
  wantedPaths,
} from './paths';

const cipher = new UrlCipher(randomBytes(32));

const camera = (over: Partial<Camera> = {}): Camera => ({
  id: 'gate',
  name: 'Gate',
  area: null,
  useCase: 'vehicle_gate',
  enabled: true,
  sourceType: 'RTSP',
  mainStreamUrlEnc: cipher.encrypt('rtsp://u:p@h/main'),
  subStreamUrlEnc: cipher.encrypt('rtsp://u:p@h/sub'),
  recordingPath: null,
  targetFps: 5,
  engineGroup: 'default',
  auditCamera: false,
  inferenceStream: 'MAIN',
  recordingEnabled: true,
  recordingStream: 'MAIN',
  retentionDays: null,
  clipBeforeSec: 15,
  clipAfterSec: 15,
  nxCameraId: null,
  activeVersion: 1,
  firstSeenAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('wantedPaths', () => {
  it('MAIN recording, SUB inference with a sub URL: main records, sub is the engine path, neither is on demand', () => {
    const wanted = wantedPaths([camera({ inferenceStream: 'SUB' })], cipher);
    expect(wanted.get('zv_gate')).toMatchObject({
      source: 'rtsp://u:p@h/main',
      record: true,
      sourceOnDemand: false,
    });
    expect(wanted.get('zv_gate_sub')).toMatchObject({
      source: 'rtsp://u:p@h/sub',
      record: false,
      sourceOnDemand: false,
    });
  });

  it('recording off, inference MAIN, a sub URL: the sub path is on demand, main is not', () => {
    const wanted = wantedPaths([camera({ recordingEnabled: false })], cipher);
    expect(wanted.get('zv_gate')).toMatchObject({
      record: false,
      sourceOnDemand: false,
    });
    expect(wanted.get('zv_gate_sub')).toMatchObject({
      record: false,
      sourceOnDemand: true,
    });
  });

  it('recordingStream SUB without a sub URL records main', () => {
    const c = camera({ recordingStream: 'SUB', subStreamUrlEnc: null });
    expect(mediamtxPaths(c)).toMatchObject({
      sub: null,
      recorded: 'zv_gate',
    });
    expect(wantedPaths([c], cipher).get('zv_gate')?.record).toBe(true);
  });

  it('FILE cameras have no paths; disabled cameras are not wanted', () => {
    expect(mediamtxPaths(camera({ sourceType: 'FILE' }))).toBeNull();
    const wanted = wantedPaths(
      [
        camera({ sourceType: 'FILE' }),
        camera({ id: 'off_cam', enabled: false }),
      ],
      cipher,
    );
    expect([...wanted.keys()]).toEqual([]);
  });

  it('retentionDays null is 7d, 3 is 3d', () => {
    const wanted = (c: Camera) =>
      wantedPaths([c], cipher).get('zv_gate')?.recordDeleteAfter;
    expect(wanted(camera())).toBe('7d');
    expect(wanted(camera({ retentionDays: 3 }))).toBe('3d');
  });
});

describe('isManaged', () => {
  it('only zv_ names', () => {
    expect(isManaged('zv_gate')).toBe(true);
    expect(isManaged('feed_gate')).toBe(false);
    expect(isManaged('other_path')).toBe(false);
  });
});

describe('durationSeconds', () => {
  it('reads the spellings MediaMTX uses', () => {
    expect(durationSeconds('3d')).toBe(259200);
    expect(durationSeconds('72h0m0s')).toBe(259200);
    expect(durationSeconds('10m0s')).toBe(600);
    expect(durationSeconds('1h30m')).toBe(5400);
    expect(Number.isNaN(durationSeconds('soon'))).toBe(true);
    expect(Number.isNaN(durationSeconds(undefined))).toBe(true);
  });
});
