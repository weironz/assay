-- CreateTable
CREATE TABLE "ticket_shares" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_shares_token_hash_key" ON "ticket_shares"("token_hash");

-- CreateIndex
CREATE INDEX "ticket_shares_ticket_id_revoked_at_idx" ON "ticket_shares"("ticket_id", "revoked_at");

-- CreateIndex
CREATE INDEX "ticket_shares_token_hash_idx" ON "ticket_shares"("token_hash");

-- AddForeignKey
ALTER TABLE "ticket_shares" ADD CONSTRAINT "ticket_shares_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_shares" ADD CONSTRAINT "ticket_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
