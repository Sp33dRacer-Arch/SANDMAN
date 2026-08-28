-- SANDMAN V1.3: persistent sessions, payment providers, marketplace commissions/payouts and Syncee fulfillment
ALTER TYPE "SupplierType" ADD VALUE IF NOT EXISTS 'SYNCEE';

DO $$ BEGIN
  CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'READY', 'PAID', 'FAILED', 'BLOCKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "stripeConnectAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeConnectChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "stripeConnectPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sellerCommissionAcceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sellerCountry" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_stripeConnectAccountId_key" ON "User"("stripeConnectAccountId");

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paypalOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_paypalOrderId_key" ON "Order"("paypalOrderId");

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "sellerShippingCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sellerPayoutCents" INTEGER;

CREATE TABLE IF NOT EXISTS "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");
DO $$ BEGIN
  ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "SellerPayout" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "platformFeeCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "stripeTransferId" TEXT,
  "errorMessage" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SellerPayout_stripeTransferId_key" ON "SellerPayout"("stripeTransferId");
CREATE UNIQUE INDEX IF NOT EXISTS "SellerPayout_orderId_sellerId_key" ON "SellerPayout"("orderId", "sellerId");
CREATE INDEX IF NOT EXISTS "SellerPayout_sellerId_status_idx" ON "SellerPayout"("sellerId", "status");
DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
