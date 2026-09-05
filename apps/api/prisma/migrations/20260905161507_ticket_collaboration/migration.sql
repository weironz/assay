-- CreateEnum
CREATE TYPE "TicketParticipantRole" AS ENUM ('COLLABORATOR', 'FOLLOWER');

-- CreateTable
CREATE TABLE "ticket_participants" (
    "ticket_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "TicketParticipantRole" NOT NULL DEFAULT 'COLLABORATOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by_id" TEXT NOT NULL,

    CONSTRAINT "ticket_participants_pkey" PRIMARY KEY ("ticket_id","user_id")
);

-- CreateTable
CREATE TABLE "ticket_message_mentions" (
    "message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_message_mentions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateIndex
CREATE INDEX "ticket_participants_user_id_role_idx" ON "ticket_participants"("user_id", "role");

-- CreateIndex
CREATE INDEX "ticket_message_mentions_user_id_created_at_idx" ON "ticket_message_mentions"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_message_mentions" ADD CONSTRAINT "ticket_message_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_message_mentions" ADD CONSTRAINT "ticket_message_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
