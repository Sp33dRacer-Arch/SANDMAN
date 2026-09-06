-- Store the capture ID returned by PayPal immediately after successful capture.
-- PayPal recommends persisting this value because refunds operate on capture IDs.
ALTER TABLE "Order" ADD COLUMN "paypalCaptureId" TEXT;
CREATE UNIQUE INDEX "Order_paypalCaptureId_key" ON "Order"("paypalCaptureId");
