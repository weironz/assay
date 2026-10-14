-- Additive optional integration: existing users, tickets and attachments untouched.
CREATE TABLE "samba_identities" (
 "userId" TEXT NOT NULL PRIMARY KEY, "adObjectId" TEXT NOT NULL,
 "domain" TEXT NOT NULL, "accountName" TEXT NOT NULL, "linkedBy" TEXT NOT NULL,
 "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "samba_identities_adObjectId_key" ON "samba_identities"("adObjectId");
CREATE TABLE "samba_operations" (
 "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "actorName" TEXT NOT NULL,
 "action" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "metadata" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'pending', "result" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "samba_operations_createdAt_idx" ON "samba_operations"("createdAt");
