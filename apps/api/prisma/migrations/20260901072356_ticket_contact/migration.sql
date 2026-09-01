-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "contact" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "default_contact" JSONB;
