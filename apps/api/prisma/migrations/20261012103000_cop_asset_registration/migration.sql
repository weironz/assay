CREATE SEQUENCE asset_number_sequence START WITH 1 INCREMENT BY 1 MINVALUE 1;
SELECT setval('asset_number_sequence', GREATEST(1, COALESCE((SELECT MAX(substring(code from 4)::bigint) FROM assets WHERE code ~ '^GS-[0-9]{6,9}$'),0)), EXISTS (SELECT 1 FROM assets WHERE code ~ '^GS-[0-9]{6,9}$'));
ALTER TABLE assets ADD COLUMN "ownerName" TEXT, ADD COLUMN ownership TEXT NOT NULL DEFAULT 'OWNED', ADD COLUMN "rackName" TEXT, ADD COLUMN "rackUnit" TEXT,
 ADD COLUMN "sourceSystem" TEXT, ADD COLUMN "sourceRecordId" TEXT, ADD COLUMN "sourceUrl" TEXT, ADD COLUMN "lastSyncedAt" TIMESTAMP(3), ADD COLUMN "labelVerified" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "assets_sourceSystem_sourceRecordId_key" ON assets("sourceSystem","sourceRecordId");
ALTER TABLE assets ADD CONSTRAINT asset_ownership_valid CHECK (ownership IN ('OWNED','LEASED','CUSTOMER'));
