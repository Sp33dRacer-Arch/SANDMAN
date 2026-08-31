-- SANDMAN V2.0: verified fitment, sourcing requests, build targets and supplier metadata.
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'REVIEWING', 'SOURCED', 'CLOSED');
CREATE TYPE "FitmentSource" AS ENUM ('MANUAL', 'SUPPLIER', 'OEM', 'COMMUNITY', 'IMPORTED');

ALTER TABLE "ProductFitment"
  ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source" "FitmentSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

ALTER TABLE "SupplierProduct"
  ADD COLUMN "leadTimeDays" INTEGER,
  ADD COLUMN "warehouseCountry" TEXT,
  ADD COLUMN "reliabilityScore" DOUBLE PRECISION;

ALTER TABLE "Build"
  ADD COLUMN "targetTorqueNm" INTEGER,
  ADD COLUMN "goal" TEXT;

CREATE TABLE "VehicleRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT,
  "make" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "year" INTEGER,
  "trim" TEXT,
  "engineCode" TEXT,
  "notes" TEXT,
  "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT,
  "vehicleVariantId" TEXT,
  "partName" TEXT NOT NULL,
  "oemNumber" TEXT,
  "notes" TEXT,
  "budgetCents" INTEGER,
  "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductFitment_verified_source_idx" ON "ProductFitment"("verified", "source");
CREATE INDEX "VehicleRequest_status_createdAt_idx" ON "VehicleRequest"("status", "createdAt");
CREATE INDEX "VehicleRequest_userId_createdAt_idx" ON "VehicleRequest"("userId", "createdAt");
CREATE INDEX "PartRequest_status_createdAt_idx" ON "PartRequest"("status", "createdAt");
CREATE INDEX "PartRequest_userId_createdAt_idx" ON "PartRequest"("userId", "createdAt");
CREATE INDEX "PartRequest_vehicleVariantId_idx" ON "PartRequest"("vehicleVariantId");

ALTER TABLE "VehicleRequest"
  ADD CONSTRAINT "VehicleRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PartRequest"
  ADD CONSTRAINT "PartRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PartRequest"
  ADD CONSTRAINT "PartRequest_vehicleVariantId_fkey"
  FOREIGN KEY ("vehicleVariantId") REFERENCES "VehicleVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
