import { HttpException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';

const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return ((err as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('did not throw');
};

describe('cursor', () => {
  const cursor = { t: '2026-10-14T03:50:00.123Z', id: 'evt_0123abcd' };

  it('round trips, as an opaque URL-safe string', () => {
    const s = encodeCursor(cursor);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(cursor);
  });

  it.each([
    ['not base64 json', b64('not json')],
    ['a JSON array', b64([])],
    ['a number t', b64({ t: 1, id: 'x' })],
    ['an impossible date', b64({ t: '2026-13-45T00:00:00.000Z', id: 'x' })],
    [
      'a date that is not the canonical ISO form',
      b64({ t: '2026-10-14', id: 'x' }),
    ],
    ['no id', b64({ t: cursor.t })],
    ['an empty id', b64({ t: cursor.t, id: '' })],
    ['an id that is not a string', b64({ t: cursor.t, id: 5 })],
    ['the empty string', ''],
    ['characters outside base64url', '%%%'],
  ])('rejects %s with VALIDATION_FAILED', (_label, value) => {
    expect(code(() => decodeCursor(value))).toBe('VALIDATION_FAILED');
  });
});
