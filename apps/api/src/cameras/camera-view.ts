import type { Camera } from '../generated/prisma/client';
import type { Role } from '../generated/prisma/enums';
import { mediamtxPaths } from '../mediamtx/paths';
import type { UrlCipher } from './url-cipher';

export type UserCameraView = {
  id: string;
  name: string;
  area: string | null;
  useCase: string;
  enabled: boolean;
  activeVersion: number;
};

export type ManagerCameraView = UserCameraView & {
  sourceType: Camera['sourceType'];
  recordingPath: string | null;
  targetFps: number;
  engineGroup: string;
  auditCamera: boolean;
  inferenceStream: Camera['inferenceStream'];
  nxCameraId: string | null;
  recording: {
    enabled: boolean;
    stream: Camera['recordingStream'];
    retentionDays: number | null;
    clipBeforeSec: number;
    clipAfterSec: number;
  };
  createdAt: Date;
  updatedAt: Date;
};

export type SuperadminCameraView = ManagerCameraView & {
  mainStreamUrl: string;
  subStreamUrl: string | null;
};

export type CameraView =
  UserCameraView | ManagerCameraView | SuperadminCameraView;

/**
 * What `role` may see of a camera. The stream URLs are decrypted only for SUPERADMIN; they
 * never appear in any other view.
 */
export function toCameraView(
  camera: Camera,
  role: Role,
  cipher: UrlCipher,
): CameraView {
  const user: UserCameraView = {
    id: camera.id,
    name: camera.name,
    area: camera.area,
    useCase: camera.useCase,
    enabled: camera.enabled,
    activeVersion: camera.activeVersion,
  };
  if (role === 'USER') return user;

  const manager: ManagerCameraView = {
    ...user,
    sourceType: camera.sourceType,
    // derived, never the stored column
    recordingPath: mediamtxPaths(camera)?.recorded ?? null,
    targetFps: camera.targetFps,
    engineGroup: camera.engineGroup,
    auditCamera: camera.auditCamera,
    inferenceStream: camera.inferenceStream,
    nxCameraId: camera.nxCameraId,
    recording: {
      enabled: camera.recordingEnabled,
      stream: camera.recordingStream,
      retentionDays: camera.retentionDays,
      clipBeforeSec: camera.clipBeforeSec,
      clipAfterSec: camera.clipAfterSec,
    },
    createdAt: camera.createdAt,
    updatedAt: camera.updatedAt,
  };
  if (role !== 'SUPERADMIN') return manager;

  return {
    ...manager,
    mainStreamUrl: cipher.decrypt(camera.mainStreamUrlEnc),
    subStreamUrl: camera.subStreamUrlEnc
      ? cipher.decrypt(camera.subStreamUrlEnc)
      : null,
  };
}
