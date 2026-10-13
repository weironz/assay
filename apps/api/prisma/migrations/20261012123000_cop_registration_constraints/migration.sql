ALTER TABLE assets ALTER COLUMN ownership SET DEFAULT 'UNCONFIRMED';
ALTER TABLE assets ALTER COLUMN status SET DEFAULT 'PENDING_REGISTRATION';
ALTER TABLE assets ADD CONSTRAINT asset_label_requires_code CHECK (NOT "labelVerified" OR code IS NOT NULL);
ALTER TABLE assets ADD CONSTRAINT asset_active_registration CHECK (
  status IN ('PENDING_REGISTRATION', 'RETIRED') OR (code IS NOT NULL AND "labelVerified")
);
ALTER TABLE assets ADD CONSTRAINT asset_in_use_custodian CHECK (status <> 'IN_USE' OR "custodianId" IS NOT NULL);
