-- SANDMAN initial schema baseline
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'ADMIN', 'STAFF');
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SUBMITTED_TO_SUPPLIER', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'REFUNDED', 'FAILED');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'ACCEPTED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED');
CREATE TYPE "SupplierType" AS ENUM ('MOCK', 'CJ', 'CUSTOM');
CREATE TYPE "AddressType" AS ENUM ('SHIPPING', 'BILLING');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "phone" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Address" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" "AddressType" NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "company" TEXT,
  "line1" TEXT NOT NULL,
  "line2" TEXT,
  "city" TEXT NOT NULL,
  "state" TEXT,
  "postalCode" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VehicleMake" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleMake_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VehicleMake_name_key" ON "VehicleMake"("name");
CREATE UNIQUE INDEX "VehicleMake_slug_key" ON "VehicleMake"("slug");

CREATE TABLE "VehicleModel" (
  "id" TEXT NOT NULL,
  "makeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleModel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VehicleModel_makeId_slug_key" ON "VehicleModel"("makeId", "slug");

CREATE TABLE "VehicleVariant" (
  "id" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "yearStart" INTEGER NOT NULL,
  "yearEnd" INTEGER NOT NULL,
  "trim" TEXT,
  "chassisCode" TEXT,
  "engineCode" TEXT NOT NULL,
  "engineName" TEXT NOT NULL,
  "displacementCc" INTEGER,
  "aspiration" TEXT,
  "fuelType" TEXT,
  "transmission" TEXT,
  "drivetrain" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VehicleVariant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VehicleVariant_engineCode_idx" ON "VehicleVariant"("engineCode");
CREATE INDEX "VehicleVariant_yearStart_yearEnd_idx" ON "VehicleVariant"("yearStart", "yearEnd");

CREATE TABLE "GarageVehicle" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "vehicleVariantId" TEXT NOT NULL,
  "nickname" TEXT,
  "year" INTEGER NOT NULL,
  "vin" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GarageVehicle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GarageVehicle_userId_idx" ON "GarageVehicle"("userId");

CREATE TABLE "Category" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "parentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

CREATE TABLE "Product" (
  "id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "brand" TEXT,
  "manufacturerPn" TEXT,
  "description" TEXT NOT NULL,
  "shortDesc" TEXT,
  "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
  "categoryId" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "compareAtCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "weightGrams" INTEGER,
  "lengthMm" INTEGER,
  "widthMm" INTEGER,
  "heightMm" INTEGER,
  "requiresFitment" BOOLEAN NOT NULL DEFAULT true,
  "isUniversal" BOOLEAN NOT NULL DEFAULT false,
  "taxable" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE INDEX "Product_status_categoryId_idx" ON "Product"("status", "categoryId");
CREATE INDEX "Product_brand_idx" ON "Product"("brand");
CREATE INDEX "Product_manufacturerPn_idx" ON "Product"("manufacturerPn");

CREATE TABLE "ProductImage" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "alt" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductImage_productId_position_idx" ON "ProductImage"("productId", "position");

CREATE TABLE "ProductFitment" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "vehicleVariantId" TEXT NOT NULL,
  "notes" TEXT,
  CONSTRAINT "ProductFitment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductFitment_productId_vehicleVariantId_key" ON "ProductFitment"("productId", "vehicleVariantId");
CREATE INDEX "ProductFitment_vehicleVariantId_idx" ON "ProductFitment"("vehicleVariantId");

CREATE TABLE "Supplier" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "SupplierType" NOT NULL DEFAULT 'CUSTOM',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "baseUrl" TEXT,
  "apiKeyEnvName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

CREATE TABLE "SupplierProduct" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "supplierProductId" TEXT NOT NULL,
  "supplierSku" TEXT,
  "costCents" INTEGER NOT NULL,
  "shippingCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stock" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt" TIMESTAMP(3),
  "rawData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierProduct_supplierId_supplierProductId_key" ON "SupplierProduct"("supplierId", "supplierProductId");
CREATE INDEX "SupplierProduct_productId_active_costCents_idx" ON "SupplierProduct"("productId", "active", "costCents");

CREATE TABLE "Cart" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Cart_userId_key" ON "Cart"("userId");

CREATE TABLE "CartItem" (
  "id" TEXT NOT NULL,
  "cartId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "fitmentVehicleVariantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CartItem_cartId_productId_key" ON "CartItem"("cartId", "productId");

CREATE TABLE "Order" (
  "id" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "subtotalCents" INTEGER NOT NULL,
  "shippingCents" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL,
  "discountCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL,
  "shippingAddress" JSONB NOT NULL,
  "billingAddress" JSONB,
  "stripePaymentIntentId" TEXT,
  "customerNote" TEXT,
  "internalNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE UNIQUE INDEX "Order_stripePaymentIntentId_key" ON "Order"("stripePaymentIntentId");
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX "Order_email_idx" ON "Order"("email");

CREATE TABLE "OrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "sku" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPriceCents" INTEGER NOT NULL,
  "totalPriceCents" INTEGER NOT NULL,
  "supplierId" TEXT,
  "supplierProductId" TEXT,
  "supplierCostCents" INTEGER,
  "fitmentSnapshot" JSONB,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

CREATE TABLE "Fulfillment" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "status" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
  "supplierOrderId" TEXT,
  "trackingNumber" TEXT,
  "trackingUrl" TEXT,
  "carrier" TEXT,
  "errorMessage" TEXT,
  "rawResponse" JSONB,
  "submittedAt" TIMESTAMP(3),
  "shippedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Fulfillment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Fulfillment_orderId_idx" ON "Fulfillment"("orderId");
CREATE INDEX "Fulfillment_supplierId_status_idx" ON "Fulfillment"("supplierId", "status");

CREATE TABLE "OrderEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "processed" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");

ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleModel" ADD CONSTRAINT "VehicleModel_makeId_fkey" FOREIGN KEY ("makeId") REFERENCES "VehicleMake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleVariant" ADD CONSTRAINT "VehicleVariant_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "VehicleModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GarageVehicle" ADD CONSTRAINT "GarageVehicle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GarageVehicle" ADD CONSTRAINT "GarageVehicle_vehicleVariantId_fkey" FOREIGN KEY ("vehicleVariantId") REFERENCES "VehicleVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductFitment" ADD CONSTRAINT "ProductFitment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductFitment" ADD CONSTRAINT "ProductFitment_vehicleVariantId_fkey" FOREIGN KEY ("vehicleVariantId") REFERENCES "VehicleVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
