import bcrypt from 'bcrypt';

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A valid cost-12 hash of a password nobody knows. Login compares against it when the user does
 * not exist, so an unknown user takes as long as a wrong password.
 */
export const DUMMY_HASH =
  '$2b$12$.ldI6cdQJpQP4kh8r4S.ZeHO3b5d1fi0dYf2OjgBV32TJBwtrowke';
