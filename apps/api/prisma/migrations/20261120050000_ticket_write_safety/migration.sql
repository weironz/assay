BEGIN;

ALTER TABLE "ticket_messages" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ticket_creation_requests" (
  "requester_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "ticket_id" TEXT,
  PRIMARY KEY ("requester_id", "key"),
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ticket_creation_requests_ticket_id_idx" ON "ticket_creation_requests" ("ticket_id");

CREATE TABLE "ticket_attachment_references" (
  "message_id" TEXT NOT NULL,
  "attachment_id" TEXT NOT NULL,
  PRIMARY KEY ("message_id", "attachment_id"),
  FOREIGN KEY ("message_id") REFERENCES "ticket_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ticket_attachment_references_attachment_id_message_id_idx"
  ON "ticket_attachment_references" ("attachment_id", "message_id");

-- Preserve text links, query strings and old absolute URLs. No foreign key on
-- attachment_id: historical references to already deleted files are valid data.
INSERT INTO "ticket_attachment_references" ("message_id", "attachment_id")
SELECT DISTINCT m."id", hit[1]
FROM "ticket_messages" AS m
CROSS JOIN LATERAL regexp_matches(m."body", '/attachments/([A-Za-z0-9_-]+)/download', 'g') AS hit;

CREATE FUNCTION assay_bump_ticket_message_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."revision" := OLD."revision" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assay_ticket_message_revision
BEFORE UPDATE OF "body" ON "ticket_messages"
FOR EACH ROW WHEN (OLD."body" IS DISTINCT FROM NEW."body")
EXECUTE FUNCTION assay_bump_ticket_message_revision();

CREATE FUNCTION assay_sync_ticket_attachment_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."body" IS NOT DISTINCT FROM NEW."body" THEN RETURN NEW; END IF;
    DELETE FROM "ticket_attachment_references" WHERE "message_id" = NEW."id";
  END IF;
  INSERT INTO "ticket_attachment_references" ("message_id", "attachment_id")
  SELECT DISTINCT NEW."id", hit[1]
  FROM regexp_matches(NEW."body", '/attachments/([A-Za-z0-9_-]+)/download', 'g') AS hit;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assay_ticket_attachment_references
AFTER INSERT OR UPDATE OF "body" ON "ticket_messages"
FOR EACH ROW EXECUTE FUNCTION assay_sync_ticket_attachment_references();

COMMIT;
