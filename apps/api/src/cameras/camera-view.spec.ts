import { randomBytes } from 'node:crypto';
import type { Camera } from '../generated/prisma/client';
import { toCameraView } from './camera-view';
import { UrlCipher } from './url-cipher';

const cipher = new UrlCipher(randomBytes(32));

const camera: Camera = {
  id: 'cam_a',
  name: 'Cam A',
  area: 'Gate',
  useCase: 'vehicle_gate',
  enabled: true,
  sourceType: 'RTSP',
  mainStreamUrlEnc: cipher.encrypt('rtsp://u:p@h/main'),
  subStreamUrlEnc: cipher.encrypt('rtsp://u:p@h/sub'),
  recordingPath: 'cam_a',
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
  activeVersion: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

const USER_KEYS = ['activeVersion', 'area', 'enabled', 'id', 'name', 'useCase'];
const MANAGER_KEYS = [
  ...USER_KEYS,
  'auditCamera',
  'createdAt',
  'engineGroup',
  'inferenceStream',
  'nxCameraId',
  'recording',
  'recordingPath',
  'sourceType',
  'targetFps',
  'updatedAt',
].sort();

describe('toCameraView', () => {
  it('USER sees only the basic keys', () => {
    expect(Object.keys(toCameraView(camera, 'USER', cipher)).sort()).toEqual(
      USER_KEYS,
    );
  });

  it('MANAGER adds the config keys but no URLs', () => {
    const view = toCameraView(camera, 'MANAGER', cipher);
    expect(Object.keys(view).sort()).toEqual(MANAGER_KEYS);
    const recording = (view as { recording: Record<string, unknown> })
      .recording;
    expect(recording).toEqual({
      enabled: true,
      stream: 'MAIN',
      retentionDays: null,
      clipBeforeSec: 15,
      clipAfterSec: 15,
    });
    expect(JSON.stringify(view)).not.toContain('rtsp');
  });

  it('SUPERADMIN adds both URLs, decrypted', () => {
    const view = toCameraView(camera, 'SUPERADMIN', cipher);
    expect(Object.keys(view).sort()).toEqual(
      [...MANAGER_KEYS, 'mainStreamUrl', 'subStreamUrl'].sort(),
    );
    expect(view).toMatchObject({
      mainStreamUrl: 'rtsp://u:p@h/main',
      subStreamUrl: 'rtsp://u:p@h/sub',
    });
  });

  it('SUPERADMIN gets subStreamUrl null when none is stored', () => {
    const view = toCameraView(
      { ...camera, subStreamUrlEnc: null },
      'SUPERADMIN',
      cipher,
    );
    expect(view).toMatchObject({ subStreamUrl: null });
  });
});
