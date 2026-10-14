import { coalescing, isSilent } from './demo-feed';

describe('coalescing', () => {
  it('a call made while it runs makes it run once more afterwards, not once or three times', async () => {
    let release: () => void = () => undefined;
    const runs: number[] = [];
    const run = coalescing(async () => {
      runs.push(runs.length + 1);
      if (runs.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    run();
    run(); // arrives while the first is running
    run(); // so does this one: both are one more run
    expect(runs).toEqual([1]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runs).toEqual([1, 2]);
  });

  it('runs again for a later call once idle', async () => {
    let calls = 0;
    const run = coalescing(() => {
      calls += 1;
      return Promise.resolve();
    });
    run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(2);
  });
});

describe('isSilent', () => {
  const MIN = 60_000;
  const settings = { everyMs: 10 * MIN, forMs: 2 * MIN };

  it('every 10 minutes the next camera is silent for 2 minutes', () => {
    const slot = 7 * 10 * MIN; // slot 7 of 5 cameras: index 2
    expect(isSilent(2, 5, slot, settings)).toBe(true);
    expect(isSilent(2, 5, slot + 119_000, settings)).toBe(true);
    expect(isSilent(2, 5, slot + 2 * MIN, settings)).toBe(false);
    expect(isSilent(1, 5, slot, settings)).toBe(false);
    expect(isSilent(3, 5, slot + 10 * MIN, settings)).toBe(true);
  });

  it('false switches it off', () => {
    expect(isSilent(0, 5, 0, false)).toBe(false);
    expect(isSilent(0, 1, 30_000, false)).toBe(false);
  });
});
