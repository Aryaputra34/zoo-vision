import { sessionTtlMs } from './session-ttl';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

describe('sessionTtlMs', () => {
  it('slides 12 h from a fresh session', () => {
    expect(sessionTtlMs(0, 0)).toBe(12 * HOUR);
  });

  it('is capped by the 7 day lifetime', () => {
    expect(sessionTtlMs(0, 7 * DAY - HOUR)).toBe(HOUR);
  });

  it('is zero or less once the 7 days are over', () => {
    expect(sessionTtlMs(0, 7 * DAY)).toBeLessThanOrEqual(0);
    expect(sessionTtlMs(0, 8 * DAY)).toBeLessThanOrEqual(0);
  });
});
