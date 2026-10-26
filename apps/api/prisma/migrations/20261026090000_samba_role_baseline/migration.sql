-- Add only the permissions introduced with the optional Samba module.
-- Preserve every existing role ID, user assignment, business record and grant.
-- This migration allows an existing production database to upgrade without
-- rerunning the general-purpose seed script.
BEGIN;

INSERT INTO "permissions" ("id", "code", "name") VALUES
  ('assay_perm_samba_read', 'samba:read', '查看公司账号与文件共享'),
  ('assay_perm_samba_manage', 'samba:manage', '管理公司账号与文件共享')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "roles" ("id", "name", "description") VALUES
  ('assay_role_samba_manager', 'samba_manager', '公司账号与文件共享管理员')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" IN ('admin', 'samba_manager')
  AND p."code" IN ('samba:read', 'samba:manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

COMMIT;
