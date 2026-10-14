/** A seeded generator in [0, 1): the same seed always gives the same sequence (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit number for a string (FNV-1a), to give each camera its own stream of one seed. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

export type Rng = () => number;

/** A float in [lo, hi). */
export const between = (rng: Rng, lo: number, hi: number): number =>
  lo + (hi - lo) * rng();

/** An integer in [lo, hi] (both included). */
export const intBetween = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** One of `items`, each with a weight. */
export function weighted<T>(
  rng: Rng,
  items: readonly (readonly [T, number])[],
): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let at = rng() * total;
  for (const [item, w] of items) {
    at -= w;
    if (at < 0) return item;
  }
  return items[items.length - 1][0];
}

/** `length` lowercase hex characters. */
export function hex(rng: Rng, length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, length);
}
