import { randomBytes } from 'node:crypto';
import { loadEnv } from './env';

const key = randomBytes(32);
const required = {
  DATABASE_URL: 'postgresql://zoo_api:secret-db-pw@localhost:5432/zoo_vision',
  REDIS_URL: 'redis://:secret-redis-pw@localhost:6379/0',
  CAMERA_URL_KEY: key.toString('base64'),
  ENGINE_TOKEN: 'e'.repeat(32),
};

const errorOf = (source: Record<string, string>): string => {
  try {
    loadEnv(source);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('loadEnv did not throw');
};

describe('loadEnv', () => {
  it('applies the defaults when only the required variables are set', () => {
    expect(loadEnv(required)).toEqual({
      DATABASE_URL: required.DATABASE_URL,
      REDIS_URL: required.REDIS_URL,
      CAMERA_URL_KEY: key,
      ENGINE_TOKEN: required.ENGINE_TOKEN,
      COOKIE_SECURE: true,
      SWAGGER: 'off',
      PORT: 3001,
      INGEST: 'on',
      JOBS: 'on',
      MODELS_DIR: '/data/models',
      MODEL_UPLOAD_MAX_BYTES: 1073741824,
      SITE_TIMEZONE: 'Asia/Jakarta',
      SNAPSHOT_DIR: '/data/snapshots',
      MEDIAMTX_PLAYBACK_URL: undefined,
      MEDIAMTX_API_URL: undefined,
      MEDIAMTX_PASSWORD: undefined,
    });
  });

  it('reads the optional variables', () => {
    const env = loadEnv({
      ...required,
      COOKIE_SECURE: 'false',
      SWAGGER: 'public',
      PORT: '8080',
      INGEST: 'off',
      JOBS: 'off',
      MODELS_DIR: '/srv/models',
      MODEL_UPLOAD_MAX_BYTES: '2048',
      SITE_TIMEZONE: 'Asia/Makassar',
      SNAPSHOT_DIR: '/srv/snapshots',
      MEDIAMTX_PLAYBACK_URL: 'http://mediamtx:9996',
    });
    expect(env).toMatchObject({
      COOKIE_SECURE: false,
      SWAGGER: 'public',
      PORT: 8080,
      INGEST: 'off',
      JOBS: 'off',
      MODELS_DIR: '/srv/models',
      MODEL_UPLOAD_MAX_BYTES: 2048,
      SITE_TIMEZONE: 'Asia/Makassar',
      SNAPSHOT_DIR: '/srv/snapshots',
      MEDIAMTX_PLAYBACK_URL: 'http://mediamtx:9996',
    });
  });

  it('names MEDIAMTX_PLAYBACK_URL when it is not an http(s) URL; an empty one is unset', () => {
    expect(
      errorOf({ ...required, MEDIAMTX_PLAYBACK_URL: 'rtsp://mediamtx:8554' }),
    ).toMatch(/^ {2}MEDIAMTX_PLAYBACK_URL: must be an http\(s\) URL/m);
    expect(
      loadEnv({ ...required, MEDIAMTX_PLAYBACK_URL: '' }).MEDIAMTX_PLAYBACK_URL,
    ).toBeUndefined();
  });

  it('MEDIAMTX_API_URL needs MEDIAMTX_PASSWORD of 12 characters or more, and never echoes it', () => {
    const api = 'http://host.docker.internal:9997';
    expect(errorOf({ ...required, MEDIAMTX_API_URL: api })).toMatch(
      /^ {2}MEDIAMTX_PASSWORD: required/m,
    );
    const short = errorOf({
      ...required,
      MEDIAMTX_API_URL: api,
      MEDIAMTX_PASSWORD: 'too-short',
    });
    expect(short).toMatch(/^ {2}MEDIAMTX_PASSWORD: must be at least 12/m);
    expect(short).not.toContain('too-short');
    expect(
      loadEnv({
        ...required,
        MEDIAMTX_API_URL: api,
        MEDIAMTX_PASSWORD: 'long-enough-pw-1',
      }),
    ).toMatchObject({
      MEDIAMTX_API_URL: api,
      MEDIAMTX_PASSWORD: 'long-enough-pw-1',
    });
    expect(
      errorOf({ ...required, MEDIAMTX_API_URL: 'rtsp://mediamtx:8554' }),
    ).toMatch(/^ {2}MEDIAMTX_API_URL: must be an http\(s\) URL/m);
  });

  it('names SITE_TIMEZONE when it is not an IANA time zone', () => {
    expect(errorOf({ ...required, SITE_TIMEZONE: 'Mars/Base' })).toMatch(
      /^ {2}SITE_TIMEZONE: must be an IANA time zone/m,
    );
  });

  it('treats an empty optional variable as unset', () => {
    expect(loadEnv({ ...required, SWAGGER: '', PORT: '' })).toMatchObject({
      SWAGGER: 'off',
      PORT: 3001,
    });
  });

  it('names every bad variable in one error', () => {
    const message = errorOf({
      REDIS_URL: 'http://localhost:6379',
      CAMERA_URL_KEY: randomBytes(16).toString('base64'),
      COOKIE_SECURE: 'yes',
      SWAGGER: 'private',
      PORT: '70000',
      INGEST: 'maybe',
      JOBS: 'sometimes',
      MODEL_UPLOAD_MAX_BYTES: '0',
    });
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'CAMERA_URL_KEY',
      'ENGINE_TOKEN',
      'COOKIE_SECURE',
      'SWAGGER',
      'PORT',
      'INGEST',
      'JOBS',
      'MODEL_UPLOAD_MAX_BYTES',
    ]) {
      expect(message).toMatch(new RegExp(`^  ${name}: `, 'm'));
    }
  });

  it.each([
    ['16 bytes', randomBytes(16).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['not base64', '!'.repeat(44)],
    ['hex instead of base64', randomBytes(32).toString('hex')],
  ])('rejects a CAMERA_URL_KEY of %s', (_label, value) => {
    expect(errorOf({ ...required, CAMERA_URL_KEY: value })).toMatch(
      /CAMERA_URL_KEY: must be base64 that decodes to 32 bytes/,
    );
  });

  it.each([
    ['missing', undefined],
    ['31 characters', 'x'.repeat(31)],
  ])('names ENGINE_TOKEN when it is %s, without its value', (_label, value) => {
    const rest: Record<string, string> = { ...required };
    delete rest.ENGINE_TOKEN;
    const message = errorOf(
      value === undefined ? rest : { ...rest, ENGINE_TOKEN: value },
    );
    expect(message).toMatch(/^ {2}ENGINE_TOKEN: /m);
    if (value !== undefined) expect(message).not.toContain(value);
  });

  it('never echoes secret values in the error', () => {
    const message = errorOf({
      DATABASE_URL: 'mysql://root:secret-db-pw@localhost/zoo',
      REDIS_URL: required.REDIS_URL,
      CAMERA_URL_KEY: randomBytes(16).toString('base64') + 'secret',
    });
    expect(message).not.toMatch(/secret/);
  });
});
