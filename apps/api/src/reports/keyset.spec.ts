import { keysetAfter } from './keyset';

describe('keysetAfter', () => {
  const at = new Date('2026-10-14T03:00:00.000Z');

  it('ascending: rows after (time, id), with the time bound Postgres can start its index scan at', () => {
    expect(keysetAfter('time', { value: at, id: 'evt_5' }, 'asc')).toEqual({
      AND: [
        { time: { gte: at } },
        {
          OR: [{ time: { gt: at } }, { time: at, id: { gt: 'evt_5' } }],
        },
      ],
    });
  });

  it('descending: the same with the comparisons turned round, on any sort column', () => {
    expect(keysetAfter('start', { value: at, id: 'ses_5' }, 'desc')).toEqual({
      AND: [
        { start: { lte: at } },
        {
          OR: [{ start: { lt: at } }, { start: at, id: { lt: 'ses_5' } }],
        },
      ],
    });
  });
});
