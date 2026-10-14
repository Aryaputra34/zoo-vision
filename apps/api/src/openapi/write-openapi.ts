import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { configureRoutes } from '../bootstrap';
import { loadEnv } from '../config/env';
import { createOpenApiDocument } from './swagger';

/**
 * `npm run openapi`: builds the app without `init()` (no lifecycle hook runs, so nothing connects)
 * and writes `apps/api/openapi.json`. The addresses below are never dialled. Postgres and Redis
 * need not be running.
 */
async function main(): Promise<void> {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://zoo_api:unused@127.0.0.1:1/zoo_vision',
    REDIS_URL: 'redis://127.0.0.1:1',
    CAMERA_URL_KEY: Buffer.alloc(32, 1).toString('base64'),
    ENGINE_TOKEN: 'openapi-script-engine-token-0123456789abcdef',
    INGEST: 'off',
    JOBS: 'off',
    SWAGGER: 'off',
  });
  const app = await NestFactory.create(AppModule.forRoot(env), {
    logger: false,
  });
  configureRoutes(app);
  const doc = createOpenApiDocument(app);
  const target = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  await app.close();
  // the dummy Redis client would otherwise keep retrying
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
