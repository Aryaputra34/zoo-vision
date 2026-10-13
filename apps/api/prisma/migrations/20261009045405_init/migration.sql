-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'MANAGER', 'USER');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('RTSP', 'MEDIAMTX', 'NX', 'FILE');

-- CreateEnum
CREATE TYPE "StreamChoice" AS ENUM ('MAIN', 'SUB');

-- CreateEnum
CREATE TYPE "LoginResult" AS ENUM ('SUCCESS', 'WRONG_PASSWORD', 'DISABLED', 'LOCKED', 'RATE_LIMITED', 'LOGOUT');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('info', 'warning', 'critical');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginLog" (
    "id" BIGSERIAL NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" TEXT NOT NULL,
    "userId" UUID,
    "result" "LoginResult" NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LoginLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "useCase" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceType" "SourceType" NOT NULL,
    "mainStreamUrlEnc" TEXT NOT NULL,
    "subStreamUrlEnc" TEXT,
    "recordingPath" TEXT,
    "targetFps" INTEGER NOT NULL DEFAULT 5,
    "engineGroup" TEXT NOT NULL DEFAULT 'default',
    "auditCamera" BOOLEAN NOT NULL DEFAULT false,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "recordingStream" "StreamChoice" NOT NULL DEFAULT 'MAIN',
    "retentionDays" INTEGER,
    "clipBeforeSec" INTEGER NOT NULL DEFAULT 15,
    "clipAfterSec" INTEGER NOT NULL DEFAULT 15,
    "nxCameraId" TEXT,
    "activeVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraConfigVersion" (
    "cameraId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "useCase" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraConfigVersion_pkey" PRIMARY KEY ("cameraId","version")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "cameraId" TEXT,
    "useCase" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "configVersion" INTEGER,
    "schemaVersion" INTEGER NOT NULL,
    "snapshotPath" TEXT,
    "data" JSONB NOT NULL,
    "ingestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interval" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "useCase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT,
    "start" TIMESTAMPTZ(3) NOT NULL,
    "end" TIMESTAMPTZ(3),
    "endReason" TEXT,
    "configVersion" INTEGER,
    "schemaVersion" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "Interval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "cameraId" TEXT NOT NULL,
    "useCase" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minute" TIMESTAMPTZ(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("cameraId","name","minute")
);

-- CreateTable
CREATE TABLE "DeadEvent" (
    "id" BIGSERIAL NOT NULL,
    "streamId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_time_idx" ON "AuditLog"("entity", "entityId", "time");

-- CreateIndex
CREATE INDEX "AuditLog_time_idx" ON "AuditLog"("time");

-- CreateIndex
CREATE INDEX "LoginLog_time_idx" ON "LoginLog"("time");

-- CreateIndex
CREATE INDEX "Event_cameraId_type_time_idx" ON "Event"("cameraId", "type", "time");

-- CreateIndex
CREATE INDEX "Event_time_idx" ON "Event"("time");

-- CreateIndex
CREATE INDEX "Interval_cameraId_kind_start_idx" ON "Interval"("cameraId", "kind", "start");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraConfigVersion" ADD CONSTRAINT "CameraConfigVersion_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interval" ADD CONSTRAINT "Interval_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
