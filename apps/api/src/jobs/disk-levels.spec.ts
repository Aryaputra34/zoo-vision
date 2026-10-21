import { type Level, nextLevel } from './disk-levels';

/** Feeds the readings one after another and returns what each crossed. */
const run = (readings: number[]) => {
  let level: Level = 'ok';
  return readings.map((used) => {
    const next = nextLevel(level, used);
    level = next.level;
    return next.crossed;
  });
};

describe('nextLevel', () => {
  it('80 → 97 → 94 → 96 emits one critical and no warning; it re-arms only below 93', () => {
    expect(run([80, 97, 94, 96])).toEqual([null, 'critical', null, null]);
    expect(run([97, 92, 96])).toEqual(['critical', null, 'critical']);
  });

  it('warning at 85, held at 84, re-armed below 83', () => {
    expect(run([84, 85, 84, 83, 82, 85])).toEqual([
      null,
      'warning',
      null,
      null,
      null,
      'warning',
    ]);
  });

  it('a critical disk that falls to 90 is a warning disk, so 95 again is a new critical', () => {
    expect(run([96, 90, 84, 95])).toEqual(['critical', null, null, 'critical']);
  });
});
