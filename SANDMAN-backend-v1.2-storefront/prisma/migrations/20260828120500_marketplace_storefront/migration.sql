-- SANDMAN v1.2 marketplace storefront
CREATE TYPE "ProductSource" AS ENUM ('DROPSHIP', 'MARKETPLACE');
CREATE TYPE "PartCondition" AS ENUM ('NEW', 'USED', 'REMANUFACTURED', 'OPEN_BOX');

ALTER TABLE "Product"
  ADD COLUMN "sourceType" "ProductSource" NOT NULL DEFAULT 'DROPSHIP',
  ADD COLUMN "condition" "PartCondition" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "stockQuantity" INTEGER,
  ADD COLUMN "sellerShippingCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sellerLocation" TEXT,
  ADD COLUMN "sellerNotes" TEXT;

ALTER TABLE "OrderItem"
  ADD COLUMN "sourceType" "ProductSource" NOT NULL DEFAULT 'DROPSHIP',
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "sellerTrackingNumber" TEXT,
  ADD COLUMN "sellerCarrier" TEXT,
  ADD COLUMN "sellerShippedAt" TIMESTAMP(3);

CREATE INDEX "Product_sourceType_status_createdAt_idx" ON "Product"("sourceType", "status", "createdAt");
CREATE INDEX "Product_sellerId_status_idx" ON "Product"("sellerId", "status");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
