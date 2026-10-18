/** Injection token for the validated {@link Env}. */
export const ENV = Symbol('ENV');

export type Env = Readonly<{
  /** Postgres as `zoo_api`. The Prisma CLI uses DATABASE_MIGRATE_URL (prisma.config.ts). */
  DATABASE_URL: string;
  REDIS_URL: string;
  /** AES-256 key for the stored camera stream URLs (decoded from base64). */
  CAMERA_URL_KEY: Buffer;
  /** Shared secret of the Python engine for /internal/engine/* (Authorization: Bearer). */
  ENGINE_TOKEN: string;
  COOKIE_SECURE: boolean;
  /** `superadmin`: the docs answer 404 unless a SUPERADMIN session or API token asks. */
  SWAGGER: 'public' | 'superadmin' | 'off';
  PORT: number;
  /** Whether the Redis stream consumer runs in this process. */
  INGEST: 'on' | 'off';
  /** Whether background jobs (the offline check) run in this process. */
  JOBS: 'on' | 'off';
  /** The AI models folder: `inbox/`, `registry/` and the built-in files of tools/fetch_models.py. */
  MODELS_DIR: string;
  /** Largest accepted model upload, in bytes. */
  MODEL_UPLOAD_MAX_BYTES: number;
  /** IANA zone the reports bucket by and the CSV exports write local times in (until SiteSettings). */
  SITE_TIMEZONE: string;
  /** The folder the engine writes event JPEGs to, as `<camera>/<date>/<event>.jpg` (read-only here). */
  SNAPSHOT_DIR: string;
  /** MediaMTX's playback server, e.g. http://host.docker.internal:9996; unset: clips are unavailable. */
  MEDIAMTX_PLAYBACK_URL: string | undefined;
  /**
   * The name the API resolves to find its reverse proxy (Caddy's compose service name). Only the
   * addresses it resolves to may set X-Forwarded-For; from source, set it to 127.0.0.1.
   */
  TRUSTED_PROXY_HOST: string;
  /** The recordings volume as the API sees it (read-only), for the free-space figure of stream-info. */
  RECORDINGS_DIR: string;
  /** MediaMTX's Control API, e.g. http://host.docker.internal:9997; unset: no path sync, no live video. */
  MEDIAMTX_API_URL: string | undefined;
  /** The password of MediaMTX's user `zoo` (Control API, playback). Required with MEDIAMTX_API_URL. */
  MEDIAMTX_PASSWORD: string | undefined;
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

const token32: Check<string> = (value) =>
  value.length >= 32 ? value : undefined;

const port: Check<number> = (value) => {
  const n = Number(value);
  return /^\d+$/.test(value) && n >= 1 && n <= 65535 ? n : undefined;
};

const positiveInt: Check<number> = (value) => {
  const n = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(n) && n > 0
    ? n
    : undefined;
};

const text: Check<string> = (value) => value;

const password12: Check<string> = (value) =>
  value.length >= 12 ? value : undefined;

// Region/City names only: Intl also takes "+07:00", which Postgres reads with the sign flipped
const timeZone: Check<string> = (value) => {
  if (value !== 'UTC' && !/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(value)) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
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
    ENGINE_TOKEN: read(
      'ENGINE_TOKEN',
      token32,
      'at least 32 characters (openssl rand -hex 32)',
    ),
    COOKIE_SECURE:
      read('COOKIE_SECURE', oneOf('true', 'false'), 'true or false', 'true') ===
      'true',
    SWAGGER: read(
      'SWAGGER',
      oneOf('public', 'superadmin', 'off'),
      'public, superadmin or off',
      'off',
    ),
    PORT: read('PORT', port, 'a port number (1-65535)', 3001),
    INGEST: read('INGEST', oneOf('on', 'off'), 'on or off', 'on'),
    JOBS: read('JOBS', oneOf('on', 'off'), 'on or off', 'on'),
    MODELS_DIR: read('MODELS_DIR', text, 'a folder path', '/data/models'),
    MODEL_UPLOAD_MAX_BYTES: read(
      'MODEL_UPLOAD_MAX_BYTES',
      positiveInt,
      'a positive number of bytes',
      1073741824,
    ),
    SITE_TIMEZONE: read(
      'SITE_TIMEZONE',
      timeZone,
      'an IANA time zone such as Asia/Jakarta',
      'Asia/Jakarta',
    ),
    SNAPSHOT_DIR: read(
      'SNAPSHOT_DIR',
      text,
      'a folder path',
      '/data/snapshots',
    ),
    MEDIAMTX_PLAYBACK_URL: source.MEDIAMTX_PLAYBACK_URL
      ? read('MEDIAMTX_PLAYBACK_URL', url('http:', 'https:'), 'an http(s) URL')
      : undefined,
    TRUSTED_PROXY_HOST: read(
      'TRUSTED_PROXY_HOST',
      text,
      'a host name or address',
      'caddy',
    ),
    RECORDINGS_DIR: read(
      'RECORDINGS_DIR',
      text,
      'a folder path',
      '/data/recordings',
    ),
    MEDIAMTX_API_URL: source.MEDIAMTX_API_URL
      ? read('MEDIAMTX_API_URL', url('http:', 'https:'), 'an http(s) URL')
      : undefined,
    MEDIAMTX_PASSWORD:
      source.MEDIAMTX_API_URL || source.MEDIAMTX_PASSWORD
        ? read(
            'MEDIAMTX_PASSWORD',
            password12,
            'at least 12 characters (openssl rand -hex 24)',
          )
        : undefined,
  };

  if (problems.length > 0) {
    throw new EnvError(`Invalid environment:\n${problems.join('\n')}`);
  }
  return env;
}
