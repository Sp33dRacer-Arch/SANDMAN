-- V1.4.2: atomic supplier inventory reservations and per-order-item audit state.
ALTER TABLE "SupplierProduct"
  ADD COLUMN "reservedStock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "availableStock" INTEGER;

UPDATE "SupplierProduct"
SET "availableStock" = "stock";

ALTER TABLE "OrderItem"
  ADD COLUMN "supplierLinkId" TEXT,
  ADD COLUMN "supplierStockReservedAt" TIMESTAMP(3),
  ADD COLUMN "supplierStockReleasedAt" TIMESTAMP(3),
  ADD COLUMN "supplierStockCommittedAt" TIMESTAMP(3);

CREATE INDEX "OrderItem_supplierLinkId_idx" ON "OrderItem"("supplierLinkId");

ALTER TABLE "SupplierProduct"
  ADD CONSTRAINT "SupplierProduct_reservedStock_nonnegative" CHECK ("reservedStock" >= 0),
  ADD CONSTRAINT "SupplierProduct_availableStock_nonnegative" CHECK ("availableStock" IS NULL OR "availableStock" >= 0);
