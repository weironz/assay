-- DropForeignKey
ALTER TABLE "ticket_history" DROP CONSTRAINT "ticket_history_user_id_fkey";

-- AlterTable
ALTER TABLE "ticket_history" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "first_response_due_at" TIMESTAMP(3),
ADD COLUMN     "hold_ms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hold_started_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "ticket_history" ADD CONSTRAINT "ticket_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
