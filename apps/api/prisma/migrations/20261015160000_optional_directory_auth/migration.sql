-- Additive only: no changes to existing users, credentials, roles or business data.
CREATE TABLE "directory_identities" (
  "user_id" TEXT PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "account_name" TEXT NOT NULL,
  "group_sids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "role_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "directory_identities_provider_id_object_id_key" ON "directory_identities"("provider_id", "object_id");
CREATE TABLE "directory_group_roles" (
  "provider_id" TEXT NOT NULL,
  "group_sid" TEXT NOT NULL,
  "group_name" TEXT NOT NULL,
  "role_name" TEXT NOT NULL,
  PRIMARY KEY ("provider_id", "group_sid", "role_name")
);
