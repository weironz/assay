BEGIN;

CREATE TABLE "ticket_number_counters" (
  "day" TEXT PRIMARY KEY,
  "last_value" BIGINT NOT NULL
);

INSERT INTO "ticket_number_counters" ("day", "last_value")
SELECT split_part("ticket_no", '-', 2), max(split_part("ticket_no", '-', 3)::bigint)
FROM "tickets"
WHERE "ticket_no" ~ '^WO-[0-9]{8}-[0-9]{1,18}$'
GROUP BY 1;

-- Track explicit numbers written by import tools or a rolled-back API.
CREATE FUNCTION assay_track_ticket_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  date_key text;
  seq bigint;
BEGIN
  IF NEW."ticket_no" ~ '^WO-[0-9]{8}-[0-9]{1,18}$' THEN
    date_key := split_part(NEW."ticket_no", '-', 2);
    seq := split_part(NEW."ticket_no", '-', 3)::bigint;
    INSERT INTO "ticket_number_counters" ("day", "last_value")
    VALUES (date_key, seq)
    ON CONFLICT ("day") DO UPDATE
    SET "last_value" = excluded."last_value"
    WHERE "ticket_number_counters"."last_value" < excluded."last_value";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assay_ticket_number_high_water
BEFORE INSERT ON "tickets" FOR EACH ROW EXECUTE FUNCTION assay_track_ticket_number();

CREATE TABLE "ticket_upload_usage" (
  "id" TEXT PRIMARY KEY,
  "uploader_id" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ticket_upload_usage_uploader_id_created_at_idx"
  ON "ticket_upload_usage" ("uploader_id", "created_at");
CREATE INDEX "ticket_upload_usage_created_at_idx" ON "ticket_upload_usage" ("created_at");

INSERT INTO "ticket_upload_usage" ("id", "uploader_id", "file_size", "created_at")
SELECT "id", "uploader_id", "file_size", "created_at"
FROM "ticket_attachments"
WHERE "created_at" >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '24 hours';

-- Each successful upload counts for the original uploader even if the
-- attachment is subsequently deleted. No foreign key to the live objects.
CREATE FUNCTION assay_record_ticket_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ticket_upload_usage" ("id", "uploader_id", "file_size", "created_at")
  VALUES (NEW."id", NEW."uploader_id", NEW."file_size", NEW."created_at");
  RETURN NEW;
END;
$$;

CREATE TRIGGER assay_ticket_upload_receipt
AFTER INSERT ON "ticket_attachments" FOR EACH ROW EXECUTE FUNCTION assay_record_ticket_upload();

COMMIT;
