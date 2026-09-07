-- SANDMAN V2.6: Vinyasa catalogue, pricing automation and supplier-order integration.
ALTER TABLE "SupplierProduct"
  ADD COLUMN "suggestedRetailCents" INTEGER,
  ADD COLUMN "autoPrice" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "markupOverridePercent" DOUBLE PRECISION,
  ADD COLUMN "retailOverrideCents" INTEGER,
  ADD COLUMN "lastPriceAppliedAt" TIMESTAMP(3);

CREATE TABLE "SupplierIntegrationConfig" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'custom',
  "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
  "defaultMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 40,
  "minMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
  "maxMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 800,
  "adaptivePricingEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "lowCostThresholdCents" INTEGER NOT NULL DEFAULT 2500,
  "lowCostMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 80,
  "midCostThresholdCents" INTEGER NOT NULL DEFAULT 10000,
  "midCostMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "highCostMarkupPercent" DOUBLE PRECISION NOT NULL DEFAULT 30,
  "useSupplierRetail" BOOLEAN NOT NULL DEFAULT TRUE,
  "autoPublish" BOOLEAN NOT NULL DEFAULT TRUE,
  "deactivateMissing" BOOLEAN NOT NULL DEFAULT FALSE,
  "overwriteProductContent" BOOLEAN NOT NULL DEFAULT TRUE,
  "overwriteImages" BOOLEAN NOT NULL DEFAULT TRUE,
  "priceRounding" TEXT NOT NULL DEFAULT 'ENDING_99',
  "paymentMode" TEXT NOT NULL DEFAULT 'wallet',
  "productsPath" TEXT NOT NULL DEFAULT '/products',
  "ordersPath" TEXT NOT NULL DEFAULT '/orders',
  "orderStatusPathTemplate" TEXT NOT NULL DEFAULT '/orders/{id}',
  "pageSize" INTEGER NOT NULL DEFAULT 100,
  "maxImportProducts" INTEGER NOT NULL DEFAULT 25000,
  "lastSyncAt" TIMESTAMP(3),
  "lastSyncStatus" TEXT,
  "lastSyncMessage" TEXT,
  "syncLeaseUntil" TIMESTAMP(3),
  "syncLeaseOwner" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierIntegrationConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierIntegrationConfig_supplierId_key" ON "SupplierIntegrationConfig"("supplierId");
CREATE INDEX "SupplierIntegrationConfig_autoSyncEnabled_syncLeaseUntil_idx" ON "SupplierIntegrationConfig"("autoSyncEnabled", "syncLeaseUntil");

ALTER TABLE "SupplierIntegrationConfig"
  ADD CONSTRAINT "SupplierIntegrationConfig_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
