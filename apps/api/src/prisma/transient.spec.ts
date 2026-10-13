import { isTransient } from './transient';

const sqlstate = (originalCode: string) => ({
  code: 'P2010',
  meta: { driverAdapterError: { cause: { originalCode } } },
});

describe('isTransient', () => {
  it.each([
    ['P1001', { code: 'P1001' }],
    ['P1008', { code: 'P1008' }],
    ['P2034', { code: 'P2034' }],
    ['08006', sqlstate('08006')],
    ['40P01', sqlstate('40P01')],
    ['42501', sqlstate('42501')],
    ['42P01', sqlstate('42P01')],
    ['53300', sqlstate('53300')],
    ['58030', sqlstate('58030')],
    ['XX000', sqlstate('XX000')],
  ])('%s is transient', (_name, err) => {
    expect(isTransient(err)).toBe(true);
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['22007 invalid datetime', sqlstate('22007')],
    ['23505 unique violation', sqlstate('23505')],
    ['null', null],
  ])('%s is not', (_name, err) => {
    expect(isTransient(err)).toBe(false);
  });
});
