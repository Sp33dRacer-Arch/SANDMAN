import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { optionalAuth, requireAuth } from '../../middleware/auth';

export const experienceRouter = Router();

experienceRouter.get('/home', optionalAuth, asyncHandler(async (req, res) => {
  const primary = req.auth ? await prisma.garageVehicle.findFirst({ where: { userId: req.auth.userId, isPrimary: true }, include: { vehicleVariant: { include: { model: { include: { make: true } } } } } }) : null;
  const [trending, marketplace, forGarage] = await Promise.all([
    prisma.product.findMany({ where: { status: 'ACTIVE' }, include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true }, orderBy: [{ purchaseCount: 'desc' }, { viewCount: 'desc' }], take: 8 }),
    prisma.product.findMany({ where: { status: 'ACTIVE', sourceType: 'MARKETPLACE', stockQuantity: { gt: 0 } }, include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true, seller: { select: { id: true, sellerProfile: true } } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    primary ? prisma.product.findMany({ where: { status: 'ACTIVE', OR: [{ isUniversal: true }, { fitments: { some: { vehicleVariantId: primary.vehicleVariantId } } }] }, include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true }, orderBy: [{ purchaseCount: 'desc' }, { createdAt: 'desc' }], take: 8 }) : Promise.resolve([]),
  ]);
  res.json({ primaryGarageVehicle: primary, trending, marketplace, forGarage });
}));

experienceRouter.get('/search/suggestions', optionalAuth, asyncHandler(async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(1).max(120) }).parse(req.query);
  const [products, engines, brands] = await Promise.all([
    prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { manufacturerPn: { contains: q, mode: 'insensitive' } },
          { brand: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, slug: true, sku: true, brand: true, manufacturerPn: true, priceCents: true, images: { orderBy: { position: 'asc' }, take: 1 } },
      take: 8,
      orderBy: { purchaseCount: 'desc' },
    }),
    prisma.vehicleVariant.findMany({
      where: { OR: [{ engineCode: { contains: q, mode: 'insensitive' } }, { engineName: { contains: q, mode: 'insensitive' } }] },
      select: { id: true, engineCode: true, engineName: true, model: { select: { name: true, make: { select: { name: true } } } } },
      take: 5,
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE', brand: { contains: q, mode: 'insensitive' } },
      distinct: ['brand'],
      select: { brand: true },
      take: 5,
    }),
  ]);
  res.json({ products, engines, brands: brands.map(row => row.brand).filter(Boolean) });
}));

experienceRouter.post('/search/track', optionalAuth, asyncHandler(async (req, res) => {
  const body = z.object({ query: z.string().trim().min(1).max(200), resultsCount: z.number().int().min(0).max(1_000_000) }).parse(req.body);
  await prisma.searchEvent.create({ data: { ...body, userId: req.auth?.userId } });
  res.status(204).send();
}));

experienceRouter.get('/compare', asyncHandler(async (req, res) => {
  const ids = z.string().transform(v => v.split(',').filter(Boolean).slice(0, 4)).parse(req.query.ids ?? '');
  if (ids.length < 2) throw new HttpError(400, 'Choose at least two products to compare');
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, status: 'ACTIVE' },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' }, take: 1 },
      reviews: { where: { status: 'PUBLISHED' }, select: { rating: true } },
      supplierLinks: { where: { active: true }, select: { availableStock: true } },
      fitments: { select: { vehicleVariantId: true } },
    },
  });
  res.json(products.map(p => {
    const { supplierLinks, reviews, ...publicProduct } = p;
    return {
      ...publicProduct,
      rating: reviews.length ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length : null,
      reviewCount: reviews.length,
      inStock: p.sourceType === 'MARKETPLACE' ? (p.stockQuantity ?? 0) > 0 : supplierLinks.some(link => link.availableStock === null || link.availableStock > 0),
    };
  }));
}));

experienceRouter.get('/products/:id/recommendations', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const product = await prisma.product.findUnique({ where: { id }, include: { fitments: { select: { vehicleVariantId: true } } } });
  if (!product) throw new HttpError(404, 'Product not found');
  const fitmentIds = product.fitments.map(f => f.vehicleVariantId);
  const items = await prisma.product.findMany({
    where: {
      id: { not: id },
      status: 'ACTIVE',
      OR: [
        { categoryId: product.categoryId },
        ...(fitmentIds.length ? [{ fitments: { some: { vehicleVariantId: { in: fitmentIds } } } }] : []),
      ],
    },
    include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true },
    orderBy: [{ purchaseCount: 'desc' }, { viewCount: 'desc' }],
    take: 8,
  });
  res.json(items);
}));

experienceRouter.post('/products/:id/view', optionalAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const updated = await prisma.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { viewCount: { increment: 1 } } });
  if (!updated.count) throw new HttpError(404, 'Product not found');
  if (req.auth) await prisma.recentlyViewed.upsert({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, update: { viewedAt: new Date() }, create: { userId: req.auth.userId, productId: id } });
  res.status(204).send();
}));

experienceRouter.get('/recently-viewed', requireAuth, asyncHandler(async (req, res) => {
  const rows = await prisma.recentlyViewed.findMany({
    where: { userId: req.auth!.userId },
    include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true } } },
    orderBy: { viewedAt: 'desc' },
    take: 20,
  });
  res.json(rows);
}));

experienceRouter.get('/wishlist', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.wishlistItem.findMany({
    where: { userId: req.auth!.userId },
    include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 }, category: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(items);
}));

experienceRouter.post('/wishlist/:productId', requireAuth, asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const product = await prisma.product.findFirst({ where: { id: productId, status: 'ACTIVE' }, select: { id: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  const existing = await prisma.wishlistItem.findUnique({ where: { userId_productId: { userId: req.auth!.userId, productId } } });
  if (existing) return res.json(existing);
  const item = await prisma.$transaction(async tx => {
    const created = await tx.wishlistItem.create({ data: { userId: req.auth!.userId, productId } });
    await tx.product.update({ where: { id: productId }, data: { wishlistCount: { increment: 1 } } }).catch(() => undefined);
    return created;
  });
  res.status(201).json(item);
}));

experienceRouter.delete('/wishlist/:productId', requireAuth, asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const result = await prisma.wishlistItem.deleteMany({ where: { userId: req.auth!.userId, productId } });
  if (result.count) {
    await prisma.product.updateMany({ where: { id: productId, wishlistCount: { gt: 0 } }, data: { wishlistCount: { decrement: 1 } } });
  }
  res.status(204).send();
}));

experienceRouter.get('/alerts', requireAuth, asyncHandler(async (req, res) => {
  const alerts = await prisma.productAlert.findMany({
    where: { userId: req.auth!.userId, active: true },
    include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(alerts);
}));

experienceRouter.post('/alerts', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    productId: z.string().min(1),
    type: z.enum(['PRICE_DROP', 'RESTOCK']),
    targetPriceCents: z.number().int().positive().optional(),
  }).superRefine((v, ctx) => {
    if (v.type === 'PRICE_DROP' && !v.targetPriceCents) ctx.addIssue({ code: 'custom', message: 'Target price is required for price alerts', path: ['targetPriceCents'] });
  }).parse(req.body);
  const product = await prisma.product.findFirst({ where: { id: body.productId, status: 'ACTIVE' }, select: { id: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  const alert = await prisma.productAlert.upsert({
    where: { userId_productId_type: { userId: req.auth!.userId, productId: body.productId, type: body.type } },
    update: { active: true, targetPriceCents: body.targetPriceCents ?? null },
    create: { userId: req.auth!.userId, ...body },
  });
  res.status(201).json(alert);
}));

experienceRouter.delete('/alerts/:id', requireAuth, asyncHandler(async (req, res) => {
  await prisma.productAlert.updateMany({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId }, data: { active: false } });
  res.status(204).send();
}));

experienceRouter.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.notification.count({ where: { userId: req.auth!.userId, readAt: null } }),
  ]);
  res.json({ items, unread });
}));

experienceRouter.patch('/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
  const updated = await prisma.notification.updateMany({ where: { id: routeParam(req.params.id, 'id'), userId: req.auth!.userId }, data: { readAt: new Date() } });
  if (!updated.count) throw new HttpError(404, 'Notification not found');
  res.status(204).send();
}));

experienceRouter.post('/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.auth!.userId, readAt: null }, data: { readAt: new Date() } });
  res.status(204).send();
}));
