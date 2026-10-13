import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';

/** The default ENGINE_TOKEN of {@link createTestApp}. */
export const TEST_ENGINE_TOKEN = 'test-engine-token-0123456789abcdef-xyz';

/**
 * Builds and initialises the whole API the way main.ts does, against the Testcontainers
 * Postgres (as zoo_api) and Redis from the global setup. `env` overrides the defaults; an
 * invalid value rejects, just as the real app refuses to start. Close the app when done.
 */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<INestApplication<App>> {
  const config = loadEnv({
    DATABASE_URL: required('DATABASE_URL'),
    REDIS_URL: required('REDIS_URL'),
    CAMERA_URL_KEY: randomBytes(32).toString('base64'),
    ENGINE_TOKEN: TEST_ENGINE_TOKEN,
    COOKIE_SECURE: 'false',
    SWAGGER: 'off',
    INGEST: 'off',
    JOBS: 'off',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: ['error', 'warn'],
  });
  configureApp(app);
  await app.init();
  return app;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: run the e2e tests through jest-e2e.json`,
    );
  }
  return value;
}
