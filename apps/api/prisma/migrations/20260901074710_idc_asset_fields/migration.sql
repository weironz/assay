-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "cluster_id" TEXT,
ADD COLUMN     "datacenter_id" TEXT,
ADD COLUMN     "serial_number" TEXT;

-- CreateTable
CREATE TABLE "datacenters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "datacenters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clusters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "datacenter_id" TEXT,

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "datacenters_name_key" ON "datacenters"("name");

-- CreateIndex
CREATE UNIQUE INDEX "clusters_name_key" ON "clusters"("name");

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_datacenter_id_fkey" FOREIGN KEY ("datacenter_id") REFERENCES "datacenters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_datacenter_id_fkey" FOREIGN KEY ("datacenter_id") REFERENCES "datacenters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
