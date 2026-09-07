-- SANDMAN V2.6.1: Vinyasa hardening and resumable catalogue jobs.
ALTER TABLE "SupplierIntegrationConfig"
  ALTER COLUMN "maxImportProducts" SET DEFAULT 500000,
  ADD COLUMN "supplierMoneyUnit" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
  ADD COLUMN "orderSubmissionEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "orderPayloadStyle" TEXT NOT NULL DEFAULT 'CAMEL',
  ADD COLUMN "importJobStatus" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN "importJobMode" TEXT,
  ADD COLUMN "importJobPage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "importJobCursor" TEXT,
  ADD COLUMN "importJobProcessed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "importJobErrors" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "importJobStartedAt" TIMESTAMP(3),
  ADD COLUMN "importJobUpdatedAt" TIMESTAMP(3);
