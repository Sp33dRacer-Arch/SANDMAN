-- SANDMAN V1.4 marketplace experience upgrade
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');
CREATE TYPE "OfferStatus" AS ENUM ('OPEN', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "SupportCaseType" AS ENUM ('RETURN', 'NOT_RECEIVED', 'WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'COUNTERFEIT', 'OTHER');
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED', 'REJECTED', 'RESOLVED', 'CLOSED');
CREATE TYPE "AlertType" AS ENUM ('PRICE_DROP', 'RESTOCK');

ALTER TABLE "User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorSecretEnc" TEXT;

ALTER TABLE "Product"
  ADD COLUMN "warrantyText" TEXT,
  ADD COLUMN "returnDays" INTEGER,
  ADD COLUMN "installDifficulty" TEXT,
  ADD COLUMN "specs" JSONB,
  ADD COLUMN "videoUrl" TEXT,
  ADD COLUMN "shippingMinDays" INTEGER,
  ADD COLUMN "shippingMaxDays" INTEGER,
  ADD COLUMN "seoTitle" TEXT,
  ADD COLUMN "seoDescription" TEXT,
  ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purchaseCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "wishlistCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Order" ADD COLUMN "promoCode" TEXT;

CREATE TABLE "SellerProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "storeName" TEXT,
  "bio" TEXT,
  "location" TEXT,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "responseTimeHours" INTEGER,
  "totalSales" INTEGER NOT NULL DEFAULT 0,
  "ratingAverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "ratingCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SellerProfile_userId_key" ON "SellerProfile"("userId");
ALTER TABLE "SellerProfile" ADD CONSTRAINT "SellerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductReview" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "orderItemId" TEXT,
  "rating" INTEGER NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "mediaUrls" JSONB,
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductReview_orderItemId_key" ON "ProductReview"("orderItemId");
CREATE UNIQUE INDEX "ProductReview_userId_productId_orderItemId_key" ON "ProductReview"("userId", "productId", "orderItemId");
CREATE INDEX "ProductReview_productId_status_createdAt_idx" ON "ProductReview"("productId", "status", "createdAt");
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SellerReview" (
  "id" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "body" TEXT,
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT true,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SellerReview_orderItemId_key" ON "SellerReview"("orderItemId");
CREATE INDEX "SellerReview_sellerId_status_createdAt_idx" ON "SellerReview"("sellerId", "status", "createdAt");
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WishlistItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WishlistItem_userId_productId_key" ON "WishlistItem"("userId", "productId");
CREATE INDEX "WishlistItem_userId_createdAt_idx" ON "WishlistItem"("userId", "createdAt");
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductAlert" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "type" "AlertType" NOT NULL,
  "targetPriceCents" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastTriggeredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductAlert_userId_productId_type_key" ON "ProductAlert"("userId", "productId", "type");
CREATE INDEX "ProductAlert_productId_type_active_idx" ON "ProductAlert"("productId", "type", "active");
ALTER TABLE "ProductAlert" ADD CONSTRAINT "ProductAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAlert" ADD CONSTRAINT "ProductAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Build" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "garageVehicleId" TEXT,
  "vehicleVariantId" TEXT,
  "name" TEXT NOT NULL,
  "targetPowerHp" INTEGER,
  "budgetCents" INTEGER,
  "notes" TEXT,
  "isPublic" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Build_userId_updatedAt_idx" ON "Build"("userId", "updatedAt");
ALTER TABLE "Build" ADD CONSTRAINT "Build_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Build" ADD CONSTRAINT "Build_garageVehicleId_fkey" FOREIGN KEY ("garageVehicleId") REFERENCES "GarageVehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Build" ADD CONSTRAINT "Build_vehicleVariantId_fkey" FOREIGN KEY ("vehicleVariantId") REFERENCES "VehicleVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BuildItem" (
  "id" TEXT NOT NULL,
  "buildId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BuildItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BuildItem_buildId_productId_key" ON "BuildItem"("buildId", "productId");
CREATE INDEX "BuildItem_buildId_idx" ON "BuildItem"("buildId");
ALTER TABLE "BuildItem" ADD CONSTRAINT "BuildItem_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BuildItem" ADD CONSTRAINT "BuildItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Offer" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" "OfferStatus" NOT NULL DEFAULT 'OPEN',
  "parentId" TEXT,
  "createdById" TEXT NOT NULL,
  "message" TEXT,
  "expiresAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Offer_productId_status_createdAt_idx" ON "Offer"("productId", "status", "createdAt");
CREATE INDEX "Offer_buyerId_createdAt_idx" ON "Offer"("buyerId", "createdAt");
CREATE INDEX "Offer_sellerId_createdAt_idx" ON "Offer"("sellerId", "createdAt");
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CartItem" ADD COLUMN "offerId" TEXT;
CREATE UNIQUE INDEX "CartItem_offerId_key" ON "CartItem"("offerId");
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conversation_productId_buyerId_sellerId_key" ON "Conversation"("productId", "buyerId", "sellerId");
CREATE INDEX "Conversation_buyerId_updatedAt_idx" ON "Conversation"("buyerId", "updatedAt");
CREATE INDEX "Conversation_sellerId_updatedAt_idx" ON "Conversation"("sellerId", "updatedAt");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupportCase" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT,
  "sellerId" TEXT,
  "type" "SupportCaseType" NOT NULL,
  "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
  "reason" TEXT NOT NULL,
  "details" TEXT,
  "evidenceUrls" JSONB,
  "requestedRefundCents" INTEGER,
  "approvedRefundCents" INTEGER,
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportCase_userId_status_createdAt_idx" ON "SupportCase"("userId", "status", "createdAt");
CREATE INDEX "SupportCase_orderId_status_idx" ON "SupportCase"("orderId", "status");
CREATE INDEX "SupportCase_sellerId_status_idx" ON "SupportCase"("sellerId", "status");
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PromoCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "percentOff" INTEGER,
  "amountOffCents" INTEGER,
  "minimumCents" INTEGER NOT NULL DEFAULT 0,
  "maxUses" INTEGER,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

CREATE TABLE "SearchEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "query" TEXT NOT NULL,
  "resultsCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SearchEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SearchEvent_createdAt_idx" ON "SearchEvent"("createdAt");
CREATE INDEX "SearchEvent_query_idx" ON "SearchEvent"("query");
ALTER TABLE "SearchEvent" ADD CONSTRAINT "SearchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PricingRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "supplierId" TEXT,
  "categoryId" TEXT,
  "markupPercent" DOUBLE PRECISION,
  "fixedMarkupCents" INTEGER,
  "minimumProfitCents" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PricingRule_active_priority_idx" ON "PricingRule"("active", "priority");
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupplierSyncRun" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "productsSeen" INTEGER NOT NULL DEFAULT 0,
  "productsUpdated" INTEGER NOT NULL DEFAULT 0,
  "stockUpdates" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "SupplierSyncRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierSyncRun_supplierId_startedAt_idx" ON "SupplierSyncRun"("supplierId", "startedAt");
ALTER TABLE "SupplierSyncRun" ADD CONSTRAINT "SupplierSyncRun_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmailVerificationToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_userId_expiresAt_idx" ON "EmailVerificationToken"("userId", "expiresAt");
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RefundRecord" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "supportCaseId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalRefundId" TEXT,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefundRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RefundRecord_supportCaseId_key" ON "RefundRecord"("supportCaseId");
CREATE UNIQUE INDEX "RefundRecord_externalRefundId_key" ON "RefundRecord"("externalRefundId");
CREATE INDEX "RefundRecord_orderId_createdAt_idx" ON "RefundRecord"("orderId", "createdAt");
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefundRecord" ADD CONSTRAINT "RefundRecord_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RecentlyViewed" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecentlyViewed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecentlyViewed_userId_productId_key" ON "RecentlyViewed"("userId", "productId");
CREATE INDEX "RecentlyViewed_userId_viewedAt_idx" ON "RecentlyViewed"("userId", "viewedAt");
ALTER TABLE "RecentlyViewed" ADD CONSTRAINT "RecentlyViewed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecentlyViewed" ADD CONSTRAINT "RecentlyViewed_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
