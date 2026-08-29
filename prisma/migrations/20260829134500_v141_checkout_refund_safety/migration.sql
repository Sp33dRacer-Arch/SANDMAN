-- SANDMAN V1.4.1 checkout/refund safety hardening
ALTER TABLE "RefundRecord"
  ADD COLUMN IF NOT EXISTS "sellerId" TEXT,
  ADD COLUMN IF NOT EXISTS "sellerPayoutAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "platformFeeAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payoutAdjustedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "RefundRecord_sellerId_createdAt_idx"
  ON "RefundRecord"("sellerId", "createdAt");

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "refundInProgressAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundInProgressCaseId" TEXT;

ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

-- Keep exactly one live offer per buyer/seller/listing thread. Expire any
-- historical duplicates before adding the partial unique index.
WITH ranked_open_offers AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "productId", "buyerId", "sellerId"
           ORDER BY "createdAt" DESC, "id" DESC
         ) AS rn
  FROM "Offer"
  WHERE "status" = 'OPEN'
)
UPDATE "Offer"
SET "status" = 'EXPIRED'
WHERE "id" IN (SELECT "id" FROM ranked_open_offers WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "Offer_one_open_thread_idx"
  ON "Offer"("productId", "buyerId", "sellerId")
  WHERE "status" = 'OPEN';
