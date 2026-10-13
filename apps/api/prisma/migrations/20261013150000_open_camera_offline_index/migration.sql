-- One open camera_offline interval per camera (the OfflineJob inserts with ON CONFLICT DO NOTHING).
-- Prisma does not model partial indexes, so this index is not in schema.prisma: when a later
-- `prisma migrate dev` proposes dropping it, delete that line from the generated migration.
CREATE UNIQUE INDEX "Interval_open_camera_offline" ON "Interval" ("cameraId") WHERE "useCase" = 'system' AND "kind" = 'camera_offline' AND "end" IS NULL;
