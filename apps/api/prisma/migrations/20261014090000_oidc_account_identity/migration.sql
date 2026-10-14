-- Refuse ambiguous identities rather than silently choosing or merging accounts.
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");
