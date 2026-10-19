import type { UrlCipher } from '../cameras/url-cipher';
import type { Camera } from '../generated/prisma/client';

/** What the API sets on a MediaMTX path. Compared key by key in the reconcile. */
export type PathConf = {
  source: string;
  rtspTransport: 'tcp';
  record: boolean;
  recordDeleteAfter: string;
  sourceOnDemand: boolean;
};

export type CameraPaths = {
  main: string;
  sub: string | null;
  /** The path being recorded (clips are read from it); null when recording is off. */
  recorded: string | null;
  /** The path the engine reads. */
  engine: string;
};

type PathCamera = Pick<
  Camera,
  | 'id'
  | 'sourceType'
  | 'subStreamUrlEnc'
  | 'recordingEnabled'
  | 'recordingStream'
  | 'inferenceStream'
>;

/** The API owns every MediaMTX path with this prefix and touches no other. */
export const isManaged = (name: string): boolean => name.startsWith('zv_');

/** The MediaMTX paths of a camera; null for a FILE camera (the engine reads the file itself). */
export function mediamtxPaths(c: PathCamera): CameraPaths | null {
  if (c.sourceType === 'FILE') return null;
  const main = `zv_${c.id}`;
  const sub = c.subStreamUrlEnc ? `${main}_sub` : null;
  // SUB without a sub URL falls back to main
  const pick = (stream: Camera['recordingStream']) =>
    stream === 'SUB' && sub ? sub : main;
  return {
    main,
    sub,
    recorded: c.recordingEnabled ? pick(c.recordingStream) : null,
    engine: pick(c.inferenceStream),
  };
}

/**
 * The paths MediaMTX should hold: every non-FILE camera. A disabled camera keeps its paths as idle
 * ones (`source: publisher`, nobody may publish, no recording): its old recordings stay playable
 * and MediaMTX still deletes them after `recordDeleteAfter`, and its camera URL is not stored in
 * MediaMTX. Throws if a stored URL cannot be decrypted.
 */
export function wantedPaths(
  cameras: Camera[],
  cipher: UrlCipher,
  defaultRetentionDays: number,
  onDecryptError?: (cameraId: string, error: unknown) => void,
): Map<string, PathConf> {
  const wanted = new Map<string, PathConf>();
  for (const camera of cameras) {
    const paths = mediamtxPaths(camera);
    if (!paths) continue;
    const recordDeleteAfter = `${camera.retentionDays ?? defaultRetentionDays}d`;
    try {
      const conf = (name: string, encryptedUrl: string): PathConf =>
        camera.enabled
          ? {
              source: cipher.decrypt(encryptedUrl),
              rtspTransport: 'tcp',
              record: paths.recorded === name,
              recordDeleteAfter,
              // pulled only while someone watches, unless it is recorded or read by the engine
              sourceOnDemand: paths.recorded !== name && paths.engine !== name,
            }
          : {
              source: 'publisher',
              rtspTransport: 'tcp',
              record: false,
              recordDeleteAfter,
              sourceOnDemand: false,
            };
      const mainConf = conf(paths.main, camera.mainStreamUrlEnc);
      const subConf =
        paths.sub && camera.subStreamUrlEnc
          ? conf(paths.sub, camera.subStreamUrlEnc)
          : null;
      wanted.set(paths.main, mainConf);
      if (paths.sub && subConf) {
        wanted.set(paths.sub, subConf);
      }
    } catch (err) {
      if (onDecryptError) {
        onDecryptError(camera.id, err);
      } else {
        throw err;
      }
    }
  }
  return wanted;
}

const UNIT_SECONDS: Record<string, number> = {
  d: 86400,
  h: 3600,
  m: 60,
  s: 1,
  ms: 0.001,
};

/** "3d", "72h0m0s" and "10m" as seconds (MediaMTX may answer a duration in another spelling); NaN if unreadable. */
export function durationSeconds(text: unknown): number {
  if (typeof text !== 'string' || text === '') return NaN;
  let total = 0;
  let rest = text;
  while (rest !== '') {
    const m = /^(\d+(?:\.\d+)?)(ms|d|h|m|s)/.exec(rest);
    if (!m) return NaN;
    total += Number(m[1]) * UNIT_SECONDS[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total;
}
