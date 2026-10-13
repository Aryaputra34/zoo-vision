-- When the API first saw the camera's engine status key. Downtime (camera_offline) is recorded only for
-- cameras that have been seen at least once, so a camera nobody has run yet stays deletable.
-- zoo_api's table-level grants on "Camera" already cover the column.
ALTER TABLE "Camera" ADD COLUMN "firstSeenAt" TIMESTAMPTZ(3);
