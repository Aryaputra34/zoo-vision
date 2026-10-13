import { diffJson } from './json-diff';

describe('diffJson', () => {
  it('reports a nested change at its JSON pointer', () => {
    expect(
      diffJson(
        { tripwire: { start: [0, 0], end: [1, 1] } },
        { tripwire: { start: [0.5, 0], end: [1, 1] } },
      ),
    ).toEqual([{ path: '/tripwire/start', before: [0, 0], after: [0.5, 0] }]);
  });

  it('compares arrays as a whole', () => {
    const diff = diffJson(
      {
        clerk_zone: [
          [0, 0],
          [1, 1],
        ],
        a: 1,
      },
      {
        clerk_zone: [
          [0, 0],
          [1, 0.9],
        ],
        a: 1,
      },
    );
    expect(diff.map((d) => d.path)).toEqual(['/clerk_zone']);
  });

  it('an added key has only after, a removed key only before; paths are sorted', () => {
    const diff = diffJson({ b: 1, c: { x: 1 } }, { a: 2, c: {} });
    expect(diff).toEqual([
      { path: '/a', after: 2 },
      { path: '/b', before: 1 },
      { path: '/c/x', before: 1 },
    ]);
    expect(diff[0]).not.toHaveProperty('before');
    expect(diff[1]).not.toHaveProperty('after');
  });

  it('returns nothing for equal values and escapes ~ and / in keys', () => {
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
    expect(diffJson({ 'a/b': 1 }, { 'a/b': 2 })[0].path).toBe('/a~1b');
  });
});
