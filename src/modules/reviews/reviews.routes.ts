import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { isSandmanCloudinaryUrl } from '../../lib/media-url';
import { assertSafeImageUrls, moderateTextLocal } from '../../services/content-moderation.service';

export const reviewsRouter = Router();

reviewsRouter.get('/products/:productId', asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const rows = await prisma.productReview.findMany({
    where: { productId, status: 'PUBLISHED' },
    include: { user: { select: { id: true, firstName: true, lastName: true } }, orderItem: { select: { fitmentSnapshot: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const variantIds = [...new Set(rows.map(row => {
    const snapshot = row.orderItem?.fitmentSnapshot as { vehicleVariantId?: string } | null;
    return snapshot?.vehicleVariantId;
  }).filter((id): id is string => Boolean(id)))];
  const variants = variantIds.length ? await prisma.vehicleVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, yearStart: true, yearEnd: true, trim: true, engineCode: true, model: { select: { name: true, make: { select: { name: true } } } } },
  }) : [];
  const variantMap = new Map(variants.map(variant => [variant.id, variant]));
  const items = rows.map(row => {
    const snapshot = row.orderItem?.fitmentSnapshot as { vehicleVariantId?: string } | null;
    return {
      id: row.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      mediaUrls: row.mediaUrls,
      verifiedPurchase: row.verifiedPurchase,
      createdAt: row.createdAt,
      user: { firstName: row.user.firstName, lastName: row.user.lastName },
      vehicle: snapshot?.vehicleVariantId ? variantMap.get(snapshot.vehicleVariantId) ?? null : null,
    };
  });
  const [aggregate, grouped] = await Promise.all([
    prisma.productReview.aggregate({ where: { productId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.productReview.groupBy({ where: { productId, status: 'PUBLISHED' }, by: ['rating'], _count: { rating: true } }),
  ]);
  const counts = new Map(grouped.map(group => [group.rating, group._count.rating]));
  const distribution = [5, 4, 3, 2, 1].map(rating => ({ rating, count: counts.get(rating) ?? 0 }));
  res.json({ average: aggregate._avg.rating ?? 0, count: aggregate._count.rating, distribution, items });
}));

reviewsRouter.post('/products/:productId', requireAuth, asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const body = z.object({
    orderItemId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(3000).optional(),
    mediaUrls: z.array(z.string().url().refine(isSandmanCloudinaryUrl, 'Review media must use a SANDMAN image upload')).max(5).default([]),
  }).parse(req.body);

  const orderItem = await prisma.orderItem.findFirst({
    where: { id: body.orderItemId, productId, order: { userId: req.auth!.userId, paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } },
  });
  if (!orderItem) throw new HttpError(403, 'Only verified buyers can review this product');

  const existing = await prisma.productReview.findUnique({ where: { orderItemId: body.orderItemId } });
  if (existing) throw new HttpError(409, 'This purchase has already been reviewed');

  const safeMedia = await assertSafeImageUrls(body.mediaUrls, 'PRODUCT_REVIEW', req.auth!.userId);
  const review = await prisma.productReview.create({
    data: {
      userId: req.auth!.userId,
      productId,
      orderItemId: body.orderItemId,
      rating: body.rating,
      title: body.title ? moderateTextLocal(body.title, 'Review title') : undefined,
      body: body.body ? moderateTextLocal(body.body, 'Review') : undefined,
      mediaUrls: safeMedia as Prisma.InputJsonValue,
      verifiedPurchase: true,
      status: 'PUBLISHED',
    },
  });
  res.status(201).json({
    id: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body,
    mediaUrls: review.mediaUrls,
    verifiedPurchase: review.verifiedPurchase,
    createdAt: review.createdAt,
  });
}));

reviewsRouter.get('/sellers/:sellerId', asyncHandler(async (req, res) => {
  const sellerId = routeParam(req.params.sellerId, 'sellerId');
  const [seller, reviews, sold] = await Promise.all([
    prisma.user.findUnique({
      where: { id: sellerId },
      select: {
        id: true, firstName: true, lastName: true, createdAt: true, sellerCountry: true,
        sellerProfile: true,
        _count: { select: { marketplaceProducts: true } },
      },
    }),
    prisma.sellerReview.findMany({
      where: { sellerId, status: 'PUBLISHED' },
      include: { reviewer: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.orderItem.count({ where: { sellerId, sourceType: 'MARKETPLACE', order: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } } }),
  ]);
  if (!seller) throw new HttpError(404, 'Seller not found');
  const aggregate = await prisma.sellerReview.aggregate({ where: { sellerId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { rating: true } });
  const publicSeller = {
    id: seller.id,
    firstName: seller.firstName,
    lastName: seller.lastName,
    createdAt: seller.createdAt,
    sellerCountry: seller.sellerCountry,
    sellerProfile: seller.sellerProfile ? {
      storeName: seller.sellerProfile.storeName,
      bio: seller.sellerProfile.bio,
      location: seller.sellerProfile.location,
      verified: seller.sellerProfile.verified,
      responseTimeHours: seller.sellerProfile.responseTimeHours,
      totalSales: seller.sellerProfile.totalSales,
      ratingAverage: seller.sellerProfile.ratingAverage,
      ratingCount: seller.sellerProfile.ratingCount,
      createdAt: seller.sellerProfile.createdAt,
    } : null,
    _count: seller._count,
  };
  const publicReviews = reviews.map(review => ({
    id: review.id,
    rating: review.rating,
    body: review.body,
    verifiedPurchase: review.verifiedPurchase,
    createdAt: review.createdAt,
    reviewer: { firstName: review.reviewer.firstName, lastName: review.reviewer.lastName },
  }));
  res.json({ seller: publicSeller, average: aggregate._avg.rating ?? 0, reviewCount: aggregate._count.rating, sold, reviews: publicReviews });
}));

reviewsRouter.post('/sellers/:sellerId', requireAuth, asyncHandler(async (req, res) => {
  const sellerId = routeParam(req.params.sellerId, 'sellerId');
  const body = z.object({ orderItemId: z.string().min(1), rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).optional() }).parse(req.body);
  if (sellerId === req.auth!.userId) throw new HttpError(400, 'You cannot review yourself');

  const orderItem = await prisma.orderItem.findFirst({
    where: { id: body.orderItemId, sellerId, sourceType: 'MARKETPLACE', order: { userId: req.auth!.userId, paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } },
  });
  if (!orderItem) throw new HttpError(403, 'Only verified marketplace buyers can review this seller');
  if (await prisma.sellerReview.findUnique({ where: { orderItemId: body.orderItemId } })) throw new HttpError(409, 'This seller transaction has already been reviewed');

  const review = await prisma.sellerReview.create({
    data: { reviewerId: req.auth!.userId, sellerId, orderItemId: body.orderItemId, rating: body.rating, body: body.body ? moderateTextLocal(body.body, 'Seller review') : undefined },
  });

  const aggregate = await prisma.sellerReview.aggregate({ where: { sellerId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { rating: true } });
  await prisma.sellerProfile.upsert({
    where: { userId: sellerId },
    update: { ratingAverage: aggregate._avg.rating ?? 0, ratingCount: aggregate._count.rating },
    create: { userId: sellerId, ratingAverage: aggregate._avg.rating ?? 0, ratingCount: aggregate._count.rating },
  });
  res.status(201).json({
    id: review.id,
    rating: review.rating,
    body: review.body,
    verifiedPurchase: review.verifiedPurchase,
    createdAt: review.createdAt,
  });
}));
