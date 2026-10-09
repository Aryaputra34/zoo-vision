import { Role } from '../generated/prisma/enums';
import { roleAtLeast } from './actor';

describe('roleAtLeast', () => {
  const cases: [Role, Role, boolean][] = [
    ['USER', 'USER', true],
    ['USER', 'MANAGER', false],
    ['USER', 'SUPERADMIN', false],
    ['MANAGER', 'USER', true],
    ['MANAGER', 'MANAGER', true],
    ['MANAGER', 'SUPERADMIN', false],
    ['SUPERADMIN', 'USER', true],
    ['SUPERADMIN', 'MANAGER', true],
    ['SUPERADMIN', 'SUPERADMIN', true],
  ];

  it.each(cases)('%s vs minimum %s is %s', (role, min, expected) => {
    expect(roleAtLeast(role, min)).toBe(expected);
  });
});
