-- CreateEnum
CREATE TYPE "ModelFormat" AS ENUM ('ONNX', 'PT', 'ENGINE');

-- CreateEnum
CREATE TYPE "ModelSource" AS ENUM ('BUILTIN', 'FILESYSTEM', 'UPLOAD', 'CONVERTED');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'READY', 'FAILED', 'CONVERTING');

-- CreateTable
CREATE TABLE "AiModel" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "format" "ModelFormat" NOT NULL,
    "source" "ModelSource" NOT NULL,
    "status" "ModelStatus" NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT,
    "sizeBytes" BIGINT,
    "classNames" JSONB,
    "validation" JSONB,
    "convertedFromId" UUID,
    "createdById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_filePath_key" ON "AiModel"("filePath");

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_sha256_key" ON "AiModel"("sha256");

-- The API manages the registry rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON "AiModel" TO zoo_api;
