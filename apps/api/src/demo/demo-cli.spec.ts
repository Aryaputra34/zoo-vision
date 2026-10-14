import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { runCli } from '../cli';

describe('demo-seed command line', () => {
  let error: jest.SpyInstance<void, [unknown, ...unknown[]]>;
  let createContext: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    createContext = jest.spyOn(NestFactory, 'createApplicationContext');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // the addresses are never dialled: the command must refuse before it builds anything
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgresql://zoo_api:x@127.0.0.1:1/zoo',
    REDIS_URL: 'redis://127.0.0.1:1',
    CAMERA_URL_KEY: randomBytes(32).toString('base64'),
    ENGINE_TOKEN: 'demo-cli-spec-engine-token-0123456789abcdef',
    DEMO_PASSWORD: 'demo-password-123',
    ...over,
  });

  it('demo-seed without ZOO_DEMO=on exits 1 and touches nothing', async () => {
    expect(await runCli(['demo-seed'], env())).toBe(1);
    expect(await runCli(['demo-seed'], env({ ZOO_DEMO: 'off' }))).toBe(1);

    expect(error).toHaveBeenCalledWith('demo-seed runs only with ZOO_DEMO=on');
    expect(createContext).not.toHaveBeenCalled();
  });

  it('demo-seed with a 9-character DEMO_PASSWORD exits 1', async () => {
    const code = await runCli(
      ['demo-seed'],
      env({ ZOO_DEMO: 'on', DEMO_PASSWORD: '123456789' }),
    );

    expect(code).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/DEMO_PASSWORD.*10/);
    expect(createContext).not.toHaveBeenCalled();
  });

  it('an unknown command prints the usage and exits 1', async () => {
    expect(await runCli(['nope'], env())).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/demo-seed/);
  });
});
