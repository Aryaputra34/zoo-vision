import { HttpException } from '@nestjs/common';
import { MAX_RANGE_MS } from './buckets';
import { assertRange, parseRange } from './report-query';

const DAY = 24 * 3600_000;

/** The `{statusCode, code}` of the HttpException `fn` throws. */
function thrown(fn: () => unknown): { statusCode: number; code: string } {
  try {
    fn();
  } catch (err) {
    const e = err as HttpException;
    return e.getResponse() as { statusCode: number; code: string };
  }
  throw new Error('did not throw');
}

describe('parseRange', () => {
  it('accepts an offset and Z, and returns the same instants', () => {
    const range = parseRange({
      from: '2026-10-14T00:00:00+07:00',
      to: '2026-10-14T12:00:00Z',
    });
    expect(range.from.toISOString()).toBe('2026-10-13T17:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(range.cameraIds).toBeUndefined();
  });

  it.each([
    '2026-10-14T00:00:00',
    '2026-10-14',
    'yesterday',
    '2026-13-45T00:00:00Z',
  ])('rejects %s: a date without an offset, or not a date', (from) => {
    expect(
      thrown(() => parseRange({ from, to: '2026-10-15T00:00:00Z' })),
    ).toEqual({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: expect.any(String) as string,
      errors: [{ path: '/from', message: expect.any(String) as string }],
    });
  });

  it('rejects from >= to', () => {
    const same = '2026-10-14T00:00:00Z';
    expect(thrown(() => parseRange({ from: same, to: same })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('splits cameraIds on commas and refuses 51 of them, or an empty item', () => {
    const base = { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' };
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `cam${i}`).join(',');
    expect(parseRange({ ...base, cameraIds: ids(50) }).cameraIds).toHaveLength(
      50,
    );
    expect(parseRange({ ...base, cameraIds: 'a, b' }).cameraIds).toEqual([
      'a',
      'b',
    ]);
    expect(thrown(() => parseRange({ ...base, cameraIds: ids(51) })).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(thrown(() => parseRange({ ...base, cameraIds: 'a,,b' })).code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('assertRange', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const span = (ms: number) => ({ from, to: new Date(from.getTime() + ms) });

  it('allows exactly the limit of each bucket and refuses one millisecond more', () => {
    expect(MAX_RANGE_MS).toEqual({
      '5m': 2 * DAY,
      '15m': 7 * DAY,
      hour: 31 * DAY,
      day: 400 * DAY,
    });
    for (const bucket of ['5m', '15m', 'hour', 'day'] as const) {
      expect(() =>
        assertRange(span(MAX_RANGE_MS[bucket]), bucket),
      ).not.toThrow();
      expect(
        thrown(() => assertRange(span(MAX_RANGE_MS[bucket] + 1), bucket)),
      ).toMatchObject({ statusCode: 400, code: 'RANGE_TOO_LONG' });
    }
  });
});
