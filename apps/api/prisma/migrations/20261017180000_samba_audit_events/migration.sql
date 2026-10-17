BEGIN;
-- Keep the legacy operation rows and chainHash column intact. A separate event
-- ledger captures every writer and every result transition, including file and
-- directory operations. Historical state is baselined, not silently discarded.
CREATE TABLE "samba_audit_events" (
  "sequence" BIGSERIAL PRIMARY KEY,
  "operation_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "previous_hash" TEXT NOT NULL,
  "chain_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "samba_audit_events_operation_id_sequence_idx" ON "samba_audit_events"("operation_id", "sequence");

CREATE FUNCTION assay_append_samba_audit(op_id TEXT, event_type TEXT, payload JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE previous TEXT; seq BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(918273645);
  SELECT chain_hash INTO previous FROM samba_audit_events ORDER BY sequence DESC LIMIT 1;
  previous := COALESCE(previous, '');
  seq := nextval(pg_get_serial_sequence('samba_audit_events','sequence'));
  INSERT INTO samba_audit_events(sequence, operation_id, event, snapshot, previous_hash, chain_hash)
  VALUES(seq, op_id, event_type, payload, previous,
    encode(sha256(convert_to(previous || '|' || seq::text || '|' || op_id || '|' || event_type || '|' || payload::text, 'UTF8')), 'hex'));
END $$;

-- Freeze the source table while baselining and installing its capture trigger.
LOCK TABLE samba_operations IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE op RECORD; BEGIN
  FOR op IN SELECT * FROM samba_operations ORDER BY "createdAt", id LOOP
    PERFORM assay_append_samba_audit(op.id, 'BASELINE', to_jsonb(op) - 'chainHash' - 'updatedAt');
  END LOOP;
END $$;

CREATE FUNCTION assay_capture_samba_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assay_append_samba_audit(OLD.id, TG_OP, to_jsonb(OLD) - 'chainHash' - 'updatedAt');
    RETURN OLD;
  END IF;
  PERFORM assay_append_samba_audit(NEW.id, TG_OP, to_jsonb(NEW) - 'chainHash' - 'updatedAt');
  RETURN NEW;
END $$;
CREATE TRIGGER samba_operations_audit AFTER INSERT OR UPDATE OR DELETE ON samba_operations
  FOR EACH ROW EXECUTE FUNCTION assay_capture_samba_audit();

CREATE FUNCTION assay_reject_audit_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Samba audit events are append-only'; END $$;
CREATE TRIGGER samba_audit_events_immutable BEFORE UPDATE OR DELETE ON samba_audit_events
  FOR EACH ROW EXECUTE FUNCTION assay_reject_audit_rewrite();
CREATE TRIGGER samba_audit_events_no_truncate BEFORE TRUNCATE ON samba_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION assay_reject_audit_rewrite();

COMMIT;
