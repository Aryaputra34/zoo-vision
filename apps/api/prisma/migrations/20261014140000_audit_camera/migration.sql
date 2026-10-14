-- AlterTable
-- The API role already has INSERT and SELECT on "AuditLog" (append-only); a new column falls under them.
ALTER TABLE "AuditLog" ADD COLUMN "auditCamera" BOOLEAN NOT NULL DEFAULT false;
