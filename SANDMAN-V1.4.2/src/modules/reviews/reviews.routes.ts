import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';

export const reviewsRouter = Router();

reviewsRouter.get('/products/:productId', asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const rows = await prisma.productReview.findMany({
    where: { productId, status: 'PUBLISHED' },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const average = rows.length ? rows.reduce((n, row) => n + row.rating, 0) / rows.length : 0;
  const distribution = [5, 4, 3, 2, 1].map(rating => ({ rating, count: rows.filter(row => row.rating === rating).length }));
  res.json({ average, count: rows.length, distribution, items: rows });
}));

reviewsRouter.post('/products/:productId', requireAuth, asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const body = z.object({
    orderItemId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(3000).optional(),
    mediaUrls: z.array(z.string().url()).max(5).default([]),
  }).parse(req.body);

  const orderItem = await prisma.orderItem.findFirst({
    where: { id: body.orderItemId, productId, order: { userId: req.auth!.userId, paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } },
  });
  if (!orderItem) throw new HttpError(403, 'Only verified buyers can review this product');

  const existing = await prisma.productReview.findUnique({ where: { orderItemId: body.orderItemId } });
  if (existing) throw new HttpError(409, 'This purchase has already been reviewed');

  const review = await prisma.productReview.create({
    data: {
      userId: req.auth!.userId,
      productId,
      orderItemId: body.orderItemId,
      rating: body.rating,
      title: body.title,
      body: body.body,
      mediaUrls: body.mediaUrls as Prisma.InputJsonValue,
      verifiedPurchase: true,
      status: 'PUBLISHED',
    },
  });
  res.status(201).json(review);
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
  const average = reviews.length ? reviews.reduce((n, row) => n + row.rating, 0) / reviews.length : 0;
  res.json({ seller, average, reviewCount: reviews.length, sold, reviews });
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
    data: { reviewerId: req.auth!.userId, sellerId, orderItemId: body.orderItemId, rating: body.rating, body: body.body },
  });

  const aggregate = await prisma.sellerReview.aggregate({ where: { sellerId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { rating: true } });
  await prisma.sellerProfile.upsert({
    where: { userId: sellerId },
    update: { ratingAverage: aggregate._avg.rating ?? 0, ratingCount: aggregate._count.rating },
    create: { userId: sellerId, ratingAverage: aggregate._avg.rating ?? 0, ratingCount: aggregate._count.rating },
  });
  res.status(201).json(review);
}));
