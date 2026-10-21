import Redis from 'ioredis';
import { Client } from 'pg';

/**
 * Runs one SQL statement (or a parameterless script) as zoo_owner, outside the app and its
 * zoo_api grants. Use it to seed and inspect rows. Returns the result rows.
 */
export async function ownerQuery(
  sql: string,
  ...params: unknown[]
): Promise<unknown[]> {
  const client = new Client({ connectionString: env('DATABASE_MIGRATE_URL') });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as unknown[];
  } finally {
    await client.end();
  }
}

/**
 * Empties every application table (all of `public` except Prisma's migration history). The
 * one-row SiteSettings table is put back to its migration defaults instead: the app needs the row.
 */
export async function resetDb(): Promise<void> {
  const [{ tables }] = (await ownerQuery(
    `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'SiteSettings')`,
  )) as { tables: string | null }[];
  if (tables) {
    await ownerQuery(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }
  await ownerQuery(
    `UPDATE "SiteSettings" SET "siteName" = 'Zoo Vision', "timeZone" = 'Asia/Jakarta',
            "recordingRetentionDays" = 7, "snapshotRetentionDays" = 90,
            "auditSnapshotRetentionDays" = 365, "evidenceRetentionDays" = 365`,
  );
}

/** Deletes every key in the test Redis database. */
export async function flushRedis(): Promise<void> {
  const redis = new Redis(env('REDIS_URL'));
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: run the e2e tests through jest-e2e.json`,
    );
  }
  return value;
}
