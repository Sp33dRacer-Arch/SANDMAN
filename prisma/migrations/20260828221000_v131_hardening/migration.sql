-- SANDMAN V1.3.1 hardening
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "marketplaceStockReleasedAt" TIMESTAMP(3);
ALTER TABLE "SellerPayout" ADD COLUMN IF NOT EXISTS "readyAt" TIMESTAMP(3);

-- Clean up duplicate supplier fulfillments defensively before adding the unique guard.
-- Keep the oldest row for each order/supplier pair.
DELETE FROM "Fulfillment" newer
USING "Fulfillment" older
WHERE newer."orderId" = older."orderId"
  AND newer."supplierId" = older."supplierId"
  AND newer."createdAt" > older."createdAt";

CREATE UNIQUE INDEX IF NOT EXISTS "Fulfillment_orderId_supplierId_key"
ON "Fulfillment"("orderId", "supplierId");
