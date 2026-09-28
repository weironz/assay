-- Existing sessions have implicit epoch 0. Incrementing this durable value
-- invalidates even Redis session tokens omitted from Better Auth's index.
ALTER TABLE "users" ADD COLUMN "session_epoch" INTEGER NOT NULL DEFAULT 0;

-- Better Auth's reset-password/change-password handlers update accounts
-- directly. The epoch must change atomically with the credential write,
-- including an INSERT when a reset creates a missing credential account.
CREATE FUNCTION assay_bump_session_epoch_on_credential_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."providerId" = 'credential' AND NEW."password" IS NOT NULL THEN
      UPDATE "users" SET "session_epoch" = "session_epoch" + 1 WHERE "id" = NEW."userId";
    END IF;
  ELSIF NEW."providerId" = 'credential'
    AND NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE "users" SET "session_epoch" = "session_epoch" + 1 WHERE "id" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assay_credential_session_epoch
AFTER INSERT OR UPDATE OF "password" ON "accounts"
FOR EACH ROW EXECUTE FUNCTION assay_bump_session_epoch_on_credential_change();
