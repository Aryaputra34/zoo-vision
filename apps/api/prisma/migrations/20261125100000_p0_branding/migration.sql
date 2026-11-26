-- AlterTable
ALTER TABLE "SiteSettings"
ADD COLUMN     "brandSubtitle" TEXT,
ADD COLUMN     "brandLogoUrl" TEXT;

-- Rename untouched default product name to MagniVision without overwriting customized site names.
UPDATE "SiteSettings"
SET "siteName" = 'MagniVision'
WHERE "id" = 1 AND "siteName" = 'Zoo Vision';
