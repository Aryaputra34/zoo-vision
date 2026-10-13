-- ON UPDATE CASCADE let zoo_api (which may UPDATE "Camera") rewrite "cameraId" on the
-- append-only tables by changing a camera's id: Postgres runs the cascade as the table owner.
-- RESTRICT refuses an id change while rows reference it. ON DELETE behaviour is unchanged.

-- DropForeignKey
ALTER TABLE "CameraConfigVersion" DROP CONSTRAINT "CameraConfigVersion_cameraId_fkey";
ALTER TABLE "Event" DROP CONSTRAINT "Event_cameraId_fkey";
ALTER TABLE "Interval" DROP CONSTRAINT "Interval_cameraId_fkey";
ALTER TABLE "Metric" DROP CONSTRAINT "Metric_cameraId_fkey";

-- AddForeignKey
ALTER TABLE "CameraConfigVersion" ADD CONSTRAINT "CameraConfigVersion_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "Event" ADD CONSTRAINT "Event_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Interval" ADD CONSTRAINT "Interval_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
