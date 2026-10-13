-- The running API connects as zoo_api, never as the owner that runs migrations.
-- deploy/postgres/init/01-api-role.sh creates the role with LOGIN on the first Postgres start;
-- this creates it NOLOGIN when missing (tests, fresh databases).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zoo_api') THEN
    CREATE ROLE zoo_api NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO zoo_api;

-- Mutable tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "User", "ApiToken", "Camera" TO zoo_api;

-- Versions are deleted only together with their camera.
GRANT SELECT, INSERT, DELETE ON "CameraConfigVersion" TO zoo_api;

-- Append-only: no UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON "Event", "AuditLog", "LoginLog", "DeadEvent", "Interval", "Metric" TO zoo_api;

-- The only columns that may change after insert.
GRANT UPDATE ("end", "endReason", "data") ON "Interval" TO zoo_api;
GRANT UPDATE ("value") ON "Metric" TO zoo_api;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zoo_api;
