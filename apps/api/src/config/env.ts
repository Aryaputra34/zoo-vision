/** Injection token for the validated {@link Env}. */
export const ENV = Symbol('ENV');

export type Env = Readonly<{
  /** Postgres as `zoo_api`. The Prisma CLI uses DATABASE_MIGRATE_URL (prisma.config.ts). */
  DATABASE_URL: string;
  REDIS_URL: string;
  /** AES-256 key for the stored camera stream URLs (decoded from base64). */
  CAMERA_URL_KEY: Buffer;
  COOKIE_SECURE: boolean;
  SWAGGER: 'public' | 'off';
  PORT: number;
  /** Whether the Redis stream consumer runs in this process. */
  INGEST: 'on' | 'off';
}>;

export class EnvError extends Error {
  override name = 'EnvError';
}

type Source = Record<string, string | undefined>;
type Check<T> = (value: string) => T | undefined;

const url =
  (...protocols: string[]): Check<string> =>
  (value) => {
    try {
      return protocols.includes(new URL(value).protocol) ? value : undefined;
    } catch {
      return undefined;
    }
  };

const oneOf =
  <T extends string>(...allowed: T[]): Check<T> =>
  (value) =>
    (allowed as string[]).includes(value) ? (value as T) : undefined;

const key32: Check<Buffer> = (value) => {
  const bytes = Buffer.from(value, 'base64');
  // the round trip rejects characters that Buffer.from silently skips
  return bytes.length === 32 && bytes.toString('base64') === value
    ? bytes
    : undefined;
};

const port: Check<number> = (value) => {
  const n = Number(value);
  return /^\d+$/.test(value) && n >= 1 && n <= 65535 ? n : undefined;
};

/**
 * Validates the environment. Throws one {@link EnvError} naming every bad variable (never its
 * value, which may be a secret), so the app refuses to start.
 */
export function loadEnv(source: Source = process.env): Env {
  const problems: string[] = [];

  function read<T>(
    name: string,
    check: Check<T>,
    expected: string,
    fallback?: T,
  ): T {
    const raw = source[name];
    if (raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback;
      problems.push(`  ${name}: required, ${expected}`);
      return undefined as T;
    }
    const value = check(raw);
    if (value === undefined) problems.push(`  ${name}: must be ${expected}`);
    return value as T;
  }

  const env: Env = {
    DATABASE_URL: read(
      'DATABASE_URL',
      url('postgres:', 'postgresql:'),
      'a postgresql:// URL',
    ),
    REDIS_URL: read('REDIS_URL', url('redis:', 'rediss:'), 'a redis:// URL'),
    CAMERA_URL_KEY: read(
      'CAMERA_URL_KEY',
      key32,
      'base64 that decodes to 32 bytes (openssl rand -base64 32)',
    ),
    COOKIE_SECURE:
      read('COOKIE_SECURE', oneOf('true', 'false'), 'true or false', 'true') ===
      'true',
    SWAGGER: read('SWAGGER', oneOf('public', 'off'), 'public or off', 'off'),
    PORT: read('PORT', port, 'a port number (1-65535)', 3001),
    INGEST: read('INGEST', oneOf('on', 'off'), 'on or off', 'on'),
  };

  if (problems.length > 0) {
    throw new EnvError(`Invalid environment:\n${problems.join('\n')}`);
  }
  return env;
}
