-- Serialize every operation that can remove an active admin. Application
-- prechecks provide a readable error; this trigger closes concurrent races.
CREATE OR REPLACE FUNCTION assay_preserve_last_active_admin()
RETURNS trigger AS $$
DECLARE
  affected_user_id text;
  affected_role_id text;
  loses_admin boolean := false;
  active_admins integer;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP = 'DELETE' THEN
      affected_user_id := OLD.id;
      loses_admin := OLD.status = 'ACTIVE';
    ELSIF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
      affected_user_id := OLD.id;
      loses_admin := true;
    END IF;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    affected_user_id := OLD.user_id;
    affected_role_id := OLD.role_id;
    IF TG_OP = 'DELETE' THEN
      loses_admin := true;
    ELSE
      loses_admin := NEW.user_id IS DISTINCT FROM OLD.user_id OR
        NEW.role_id IS DISTINCT FROM OLD.role_id;
    END IF;
    -- On cascade from deleting a user, the users trigger already checked.
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = affected_user_id AND status = 'ACTIVE') THEN
      loses_admin := false;
    END IF;
  END IF;

  IF loses_admin AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = affected_user_id AND r.name = 'admin'
      AND (affected_role_id IS NULL OR ur.role_id = affected_role_id)
  ) THEN
    PERFORM pg_advisory_xact_lock(698103, 1);
    SELECT COUNT(DISTINCT u.id) INTO active_admins
    FROM users u JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
    WHERE u.status = 'ACTIVE' AND r.name = 'admin';
    IF active_admins <= 1 THEN
      RAISE EXCEPTION 'ASSAY_LAST_ACTIVE_ADMIN' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assay_last_admin_user_delete
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION assay_preserve_last_active_admin();

CREATE TRIGGER assay_last_admin_user_status
BEFORE UPDATE OF status ON users
FOR EACH ROW EXECUTE FUNCTION assay_preserve_last_active_admin();

CREATE TRIGGER assay_last_admin_role_delete
BEFORE DELETE ON user_roles
FOR EACH ROW EXECUTE FUNCTION assay_preserve_last_active_admin();

CREATE TRIGGER assay_last_admin_role_update
BEFORE UPDATE OF user_id, role_id ON user_roles
FOR EACH ROW EXECUTE FUNCTION assay_preserve_last_active_admin();
