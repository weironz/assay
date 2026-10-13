CREATE TABLE "asset_import_batches" (
 "id" TEXT NOT NULL, "actorId" TEXT NOT NULL, "actorName" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "asset_import_batches_pkey" PRIMARY KEY ("id")
);
