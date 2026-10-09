const HOUR_MS = 3600e3;
export const SESSION_IDLE_MS = 12 * HOUR_MS;
export const SESSION_MAX_MS = 7 * 24 * HOUR_MS;

/**
 * How long a session may live from `nowMs`: it slides 12 h from the last request but never
 * past 7 days after creation. A result of 0 or less means the session has expired.
 */
export function sessionTtlMs(createdAtMs: number, nowMs: number): number {
  return Math.min(SESSION_IDLE_MS, createdAtMs + SESSION_MAX_MS - nowMs);
}
