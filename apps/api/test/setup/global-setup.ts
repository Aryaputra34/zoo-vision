import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import type { StartedTestContainer } from 'testcontainers';

// Pinned once for the whole repo: keep in step with deploy/docker-compose.yml and engine.yml.
const POSTGRES_IMAGE = 'postgres:17.11-alpine';
const REDIS_IMAGE = 'redis:7.4.11-alpine';
const API_ROOT = path.resolve(__dirname, '..', '..');

export type E2eGlobals = typeof globalThis & {
  __zooE2eContainers?: StartedTestContainer[];
};

/**
 * Starts Postgres and Redis, migrates as zoo_owner, gives zoo_api a login, then points
 * DATABASE_URL (zoo_api), DATABASE_MIGRATE_URL (zoo_owner) and REDIS_URL at them.
 */
export default async function globalSetup(): Promise<void> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername('zoo_owner')
      .withPassword('zoo_owner')
      .withDatabase('zoo_vision')
      .start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  (globalThis as E2eGlobals).__zooE2eContainers = [postgres, redis];

  const ownerUrl = postgres.getConnectionUri();
  await migrate(ownerUrl);
  await enableApiLogin(ownerUrl);

  const apiUrl = new URL(ownerUrl);
  apiUrl.username = 'zoo_api';
  apiUrl.password = 'zoo_api';
  process.env.DATABASE_MIGRATE_URL = ownerUrl;
  process.env.DATABASE_URL = apiUrl.toString();
  process.env.REDIS_URL = redis.getConnectionUrl();
}

async function migrate(ownerUrl: string): Promise<void> {
  const prismaCli = require.resolve('prisma/build/index.js');
  try {
    await promisify(execFile)(
      process.execPath,
      [prismaCli, 'migrate', 'deploy'],
      {
        cwd: API_ROOT,
        env: {
          ...process.env,
          DATABASE_MIGRATE_URL: ownerUrl,
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        },
      },
    );
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    throw new Error(`prisma migrate deploy failed:\n${stdout}\n${stderr}`);
  }
}

// The db_roles migration creates zoo_api NOLOGIN and grants its rights; tests need it to log in.
async function enableApiLogin(ownerUrl: string): Promise<void> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zoo_api') THEN
          CREATE ROLE zoo_api;
        END IF;
      END $$`);
    await client.query(`ALTER ROLE zoo_api LOGIN PASSWORD 'zoo_api'`);
  } finally {
    await client.end();
  }
}
