-- SANDMAN V1.4 audit fixes: offer lifecycle, promo accounting and seller-case responses
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'PURCHASED';

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "promoCountedAt" TIMESTAMP(3);

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "discountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "offerId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "OrderItem_offerId_key" ON "OrderItem"("offerId");
DO $$ BEGIN
  ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Offer"
  ADD COLUMN IF NOT EXISTS "purchasedAt" TIMESTAMP(3);

ALTER TABLE "SupportCase"
  ADD COLUMN IF NOT EXISTS "sellerResponse" TEXT,
  ADD COLUMN IF NOT EXISTS "sellerRespondedAt" TIMESTAMP(3);
