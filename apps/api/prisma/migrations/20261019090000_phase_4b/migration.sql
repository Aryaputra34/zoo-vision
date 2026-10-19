-- CreateEnum
CREATE TYPE "EvidenceReason" AS ENUM ('SEVERITY', 'AUDIT_CAMERA', 'USER');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('QUEUED', 'KEPT', 'NO_RECORDING', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'DONE', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Camera" DROP COLUMN "recordingPath",
ADD COLUMN     "evidenceRetentionDays" INTEGER;

-- CreateTable
CREATE TABLE "SiteSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "siteName" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "recordingRetentionDays" INTEGER NOT NULL,
    "snapshotRetentionDays" INTEGER NOT NULL,
    "auditSnapshotRetentionDays" INTEGER NOT NULL,
    "evidenceRetentionDays" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "eventId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "eventTime" TIMESTAMPTZ(3) NOT NULL,
    "reason" "EvidenceReason" NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'QUEUED',
    "runAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "filePath" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "filePath" TEXT,
    "sizeBytes" INTEGER,
    "finishedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Evidence_status_runAt_idx" ON "Evidence"("status", "runAt");

-- CreateIndex
CREATE INDEX "Evidence_cameraId_eventTime_idx" ON "Evidence"("cameraId", "eventTime");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- The one site settings row; the CHECK keeps it the only one.
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_one_row" CHECK ("id" = 1);
INSERT INTO "SiteSettings" ("id", "siteName", "timeZone", "recordingRetentionDays", "snapshotRetentionDays",
                            "auditSnapshotRetentionDays", "evidenceRetentionDays", "updatedAt")
VALUES (1, 'Zoo Vision', 'Asia/Jakarta', 7, 90, 365, 365, now());

-- The API reads and edits the settings row, and runs the evidence and PDF queues (mutable, deletable).
GRANT SELECT, UPDATE ON "SiteSettings" TO zoo_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Evidence", "ExportJob" TO zoo_api;
