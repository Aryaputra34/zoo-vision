/** Ids that become file names (`cameraId`, `eventId`): a plain name, never a path. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(s: string): boolean {
  return SAFE_ID.test(s);
}
