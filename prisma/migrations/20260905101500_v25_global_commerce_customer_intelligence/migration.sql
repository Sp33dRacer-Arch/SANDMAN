-- SANDMAN V2.5 — Verified Fit, Global Commerce, Customer Intelligence, Privacy & Launch Readiness

CREATE TYPE "FitmentCompatibility" AS ENUM ('FITS', 'DOES_NOT_FIT');
CREATE TYPE "ReadinessStatus" AS ENUM ('NOT_STARTED', 'NEEDS_CONFIGURATION', 'NEEDS_TEST', 'PASS', 'FAIL', 'NOT_APPLICABLE');

ALTER TABLE "ProductFitment"
  ADD COLUMN "compatibility" "FitmentCompatibility" NOT NULL DEFAULT 'FITS';

ALTER TABLE "Product"
  ADD COLUMN "hsCode" TEXT,
  ADD COLUMN "countryOfOrigin" TEXT,
  ADD COLUMN "customsDescription" TEXT,
  ADD COLUMN "restrictedCountries" JSONB;

ALTER TABLE "Order"
  ADD COLUMN "taxJurisdiction" TEXT,
  ADD COLUMN "taxRateBps" INTEGER,
  ADD COLUMN "taxInclusive" BOOLEAN,
  ADD COLUMN "dutyCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "displayCurrency" TEXT,
  ADD COLUMN "fxRate" DOUBLE PRECISION,
  ADD COLUMN "importScheme" TEXT,
  ADD COLUMN "shippingQuoteMeta" JSONB;

CREATE TABLE "CustomerNote" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerTagAssignment" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "assignedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerTagAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrivacyConsent" (
  "id" TEXT NOT NULL,
  "anonymousId" TEXT NOT NULL,
  "userId" TEXT,
  "necessary" BOOLEAN NOT NULL DEFAULT true,
  "analytics" BOOLEAN NOT NULL DEFAULT false,
  "marketing" BOOLEAN NOT NULL DEFAULT false,
  "preferences" BOOLEAN NOT NULL DEFAULT false,
  "policyVersion" TEXT NOT NULL DEFAULT '2026-09-v2.5',
  "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyConsent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "anonymousId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FxRate" (
  "id" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxRule" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "region" TEXT,
  "label" TEXT NOT NULL,
  "taxType" TEXT NOT NULL DEFAULT 'VAT',
  "rateBps" INTEGER NOT NULL,
  "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
  "appliesToShipping" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShippingZone" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "countries" JSONB NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "rateCents" INTEGER NOT NULL,
  "freeShippingThresholdCents" INTEGER,
  "minDays" INTEGER,
  "maxDays" INTEGER,
  "carrierCode" TEXT,
  "serviceCode" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShippingZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommerceRegion" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en-US',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "shippingAllowed" BOOLEAN NOT NULL DEFAULT false,
  "taxRequired" BOOLEAN NOT NULL DEFAULT true,
  "dutiesRequired" BOOLEAN NOT NULL DEFAULT false,
  "paymentMethods" JSONB NOT NULL,
  "importScheme" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommerceRegion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegionalPrice" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "regionKey" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "compareAtCents" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegionalPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalReadiness" (
  "key" TEXT NOT NULL,
  "status" "ReadinessStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "note" TEXT,
  "evidence" JSONB,
  "checkedAt" TIMESTAMP(3),
  "checkedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalReadiness_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "CustomerTagAssignment_customerId_tag_key" ON "CustomerTagAssignment"("customerId", "tag");
CREATE UNIQUE INDEX "PrivacyConsent_anonymousId_key" ON "PrivacyConsent"("anonymousId");
CREATE UNIQUE INDEX "FxRate_baseCurrency_quoteCurrency_key" ON "FxRate"("baseCurrency", "quoteCurrency");
CREATE UNIQUE INDEX "CommerceRegion_country_key" ON "CommerceRegion"("country");
CREATE UNIQUE INDEX "RegionalPrice_productId_regionKey_currency_key" ON "RegionalPrice"("productId", "regionKey", "currency");

CREATE INDEX "ProductFitment_compatibility_vehicleVariantId_idx" ON "ProductFitment"("compatibility", "vehicleVariantId");
CREATE INDEX "CustomerNote_customerId_createdAt_idx" ON "CustomerNote"("customerId", "createdAt");
CREATE INDEX "CustomerNote_authorUserId_createdAt_idx" ON "CustomerNote"("authorUserId", "createdAt");
CREATE INDEX "CustomerTagAssignment_tag_createdAt_idx" ON "CustomerTagAssignment"("tag", "createdAt");
CREATE INDEX "PrivacyConsent_userId_idx" ON "PrivacyConsent"("userId");
CREATE INDEX "AnalyticsEvent_name_createdAt_idx" ON "AnalyticsEvent"("name", "createdAt");
CREATE INDEX "AnalyticsEvent_anonymousId_createdAt_idx" ON "AnalyticsEvent"("anonymousId", "createdAt");
CREATE INDEX "TaxRule_country_region_active_priority_idx" ON "TaxRule"("country", "region", "active", "priority");
CREATE INDEX "ShippingZone_active_priority_idx" ON "ShippingZone"("active", "priority");
CREATE INDEX "RegionalPrice_regionKey_currency_idx" ON "RegionalPrice"("regionKey", "currency");

ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerTagAssignment" ADD CONSTRAINT "CustomerTagAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerTagAssignment" ADD CONSTRAINT "CustomerTagAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivacyConsent" ADD CONSTRAINT "PrivacyConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RegionalPrice" ADD CONSTRAINT "RegionalPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalReadiness" ADD CONSTRAINT "OperationalReadiness_checkedByUserId_fkey" FOREIGN KEY ("checkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
