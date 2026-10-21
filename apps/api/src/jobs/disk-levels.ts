export type Level = 'ok' | 'warning' | 'critical';

const RANK: Record<Level, number> = { ok: 0, warning: 1, critical: 2 };
/** A level is reached at these usage figures … */
const REACH = { warning: 85, critical: 95 };
/** … and held until usage falls this far below them (2 points, so a disk at the line does not flap). */
const HOLD = { warning: 83, critical: 93 };

const levelAt = (
  used: number,
  t: { warning: number; critical: number },
): Level =>
  used >= t.critical ? 'critical' : used >= t.warning ? 'warning' : 'ok';

/**
 * The level a disk is at after a reading, and the level it just crossed upward (null when it did
 * not rise). Dropping never emits; 80 → 97 crosses `critical` only, with no `warning` before it.
 */
export function nextLevel(
  prev: Level,
  usedPercent: number,
): { level: Level; crossed: 'warning' | 'critical' | null } {
  const reached = levelAt(usedPercent, REACH);
  if (RANK[reached] > RANK[prev]) {
    return { level: reached, crossed: reached as 'warning' | 'critical' };
  }
  const held = levelAt(usedPercent, HOLD);
  return { level: RANK[held] < RANK[prev] ? held : prev, crossed: null };
}

/**
 * Share of the disk in use as `df` shows it, one decimal: `bavail` (what an unprivileged process
 * may still write), not `bfree`, so blocks reserved for root do not count as free.
 */
export function usedPercent(fs: {
  blocks: number;
  bfree: number;
  bavail: number;
}): number {
  const used = fs.blocks - fs.bfree;
  return used + fs.bavail > 0
    ? Math.round((used / (used + fs.bavail)) * 1000) / 10
    : 0;
}
