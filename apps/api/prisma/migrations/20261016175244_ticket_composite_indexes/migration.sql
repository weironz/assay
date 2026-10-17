-- DropIndex
DROP INDEX "ticket_messages_ticket_id_idx";

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "tickets_queue_id_status_created_at_idx" ON "tickets"("queue_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "tickets_assignee_id_status_created_at_idx" ON "tickets"("assignee_id", "status", "created_at");
