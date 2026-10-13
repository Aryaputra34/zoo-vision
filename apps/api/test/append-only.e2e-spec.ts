import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './app';
import { ownerQuery, resetDb } from './setup/db';

describe('zoo_api database rights', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(resetDb);

  it.each([
    `UPDATE "Event" SET "type" = 'x'`,
    `DELETE FROM "Event"`,
    `TRUNCATE "Event"`,
    `UPDATE "AuditLog" SET "action" = 'x'`,
    `DELETE FROM "AuditLog"`,
    `UPDATE "LoginLog" SET "username" = 'x'`,
    `DELETE FROM "LoginLog"`,
    `UPDATE "DeadEvent" SET "reason" = 'x'`,
    `UPDATE "Interval" SET "kind" = 'x'`,
    `DELETE FROM "Interval"`,
    `UPDATE "Metric" SET "name" = 'x'`,
    `DELETE FROM "Metric"`,
    `UPDATE "CameraConfigVersion" SET "note" = 'x'`,
  ])('zoo_api cannot run: %s', async (sql) => {
    await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('zoo_api can close an interval and overwrite a metric value', async () => {
    await ownerQuery(
      `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "activeVersion", "updatedAt")
       VALUES ('cam-1', 'Cam 1', 'cashier', 'FILE', 'enc', 1, now())`,
    );
    await ownerQuery(
      `INSERT INTO "Interval" ("id", "cameraId", "useCase", "kind", "start", "schemaVersion", "data")
       VALUES ('ses_1', 'cam-1', 'cashier', 'desk_unattended', now(), 1, '{"a":1}')`,
    );
    await ownerQuery(
      `INSERT INTO "Metric" ("cameraId", "useCase", "name", "minute", "value")
       VALUES ('cam-1', 'cashier', 'people', date_trunc('minute', now()), 1)`,
    );

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Interval" SET "end" = now(), "endReason" = 'ended', "data" = "data" || '{}'::jsonb`,
      ),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Metric" SET "value" = 2`),
    ).resolves.toBe(1);
  });

  it('zoo_api cannot rewrite the cameraId of append-only rows by renaming a camera', async () => {
    await ownerQuery(
      `INSERT INTO "Camera" ("id", "name", "useCase", "sourceType", "mainStreamUrlEnc", "activeVersion", "updatedAt")
       VALUES ('cam-1', 'Cam 1', 'cashier', 'FILE', 'enc', 1, now())`,
    );
    await ownerQuery(
      `INSERT INTO "Event" ("id", "time", "cameraId", "useCase", "type", "severity", "schemaVersion", "data")
       VALUES ('evt_1', now(), 'cam-1', 'cashier', 'x', 'info', 1, '{}')`,
    );

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Camera" SET "id" = 'cam-2'`),
    ).rejects.toThrow(/foreign key|violates/);

    const rows = (await ownerQuery(
      `SELECT "cameraId" FROM "Event" WHERE "id" = 'evt_1'`,
    )) as { cameraId: string }[];
    expect(rows).toEqual([{ cameraId: 'cam-1' }]);
  });

  it('every application table grants SELECT to zoo_api', async () => {
    const rows = (await ownerQuery(
      `WITH app_tables AS MATERIALIZED (
         SELECT tablename AS t FROM pg_tables
          WHERE schemaname = 'public' AND tablename <> '_prisma_migrations')
       SELECT t FROM app_tables
        WHERE NOT has_table_privilege('zoo_api', format('public.%I', t), 'SELECT')`,
    )) as { t: string }[];
    expect(rows.map((r) => r.t)).toEqual([]);
  });
});
