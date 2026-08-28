import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';

export const marketplaceRouter = Router();

const cleanSlug = (value: string) => value
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '')
  .slice(0, 120);

const listingSchema = z.object({
  name: z.string().min(3).max(240),
  brand: z.string().max(120).optional(),
  manufacturerPn: z.string().max(120).optional(),
  description: z.string().min(20).max(8000),
  shortDesc: z.string().max(500).optional(),
  categoryId: z.string().min(1),
  priceCents: z.number().int().min(100),
  condition: z.enum(['NEW', 'USED', 'REMANUFACTURED', 'OPEN_BOX']).default('USED'),
  stockQuantity: z.number().int().min(1).max(1000).default(1),
  sellerShippingCents: z.number().int().min(0).max(500_000).default(0),
  sellerLocation: z.string().max(160).optional(),
  sellerNotes: z.string().max(1200).optional(),
  images: z.array(z.object({
    url: z.string().url(),
    alt: z.string().max(240).optional(),
    position: z.number().int().min(0).max(20).default(0),
  })).max(8).default([]),
});

marketplaceRouter.get('/', asyncHandler(async (req, res) => {
  const query = z.object({
    q: z.string().optional(),
    category: z.string().optional(),
    condition: z.enum(['NEW', 'USED', 'REMANUFACTURED', 'OPEN_BOX']).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  }).parse(req.query);

  const where = {
    sourceType: 'MARKETPLACE' as const,
    status: 'ACTIVE' as const,
    ...(query.category ? { category: { slug: query.category } } : {}),
    ...(query.condition ? { condition: query.condition } : {}),
    ...(query.q ? { OR: [
      { name: { contains: query.q, mode: 'insensitive' as const } },
      { brand: { contains: query.q, mode: 'insensitive' as const } },
      { manufacturerPn: { contains: query.q, mode: 'insensitive' as const } },
      { description: { contains: query.q, mode: 'insensitive' as const } },
    ] } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: {
        category: true,
        images: { orderBy: { position: 'asc' }, take: 2 },
        seller: { select: { id: true, firstName: true, lastName: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.json({ items, total, page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)) });
}));

marketplaceRouter.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.product.findMany({
    where: { sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
    include: { category: true, images: { orderBy: { position: 'asc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(items);
}));

marketplaceRouter.get('/sales', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.orderItem.findMany({
    where: {
      sellerId: req.auth!.userId,
      sourceType: 'MARKETPLACE',
      order: { paymentStatus: 'PAID' },
    },
    include: {
      order: { select: { id: true, orderNumber: true, status: true, shippingAddress: true, createdAt: true } },
      product: { select: { id: true, slug: true, images: { orderBy: { position: 'asc' }, take: 1 } } },
    },
    orderBy: { order: { createdAt: 'desc' } },
  });
  res.json(items);
}));

marketplaceRouter.post('/', requireAuth, asyncHandler(async (req, res) => {
  const data = listingSchema.parse(req.body);
  const baseSlug = cleanSlug(data.name) || 'part';
  const slug = `${baseSlug}-${nanoid(7).toLowerCase()}`;
  const sku = `SM-MKT-${nanoid(10).toUpperCase()}`;

  const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
  if (!category) throw new HttpError(400, 'Invalid category');

  const { images, ...listing } = data;
  const product = await prisma.product.create({
    data: {
      ...listing,
      sku,
      slug,
      sourceType: 'MARKETPLACE',
      sellerId: req.auth!.userId,
      status: 'ACTIVE',
      currency: 'USD',
      requiresFitment: false,
      isUniversal: true,
      taxable: true,
      images: { create: images },
    },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      seller: { select: { id: true, firstName: true, lastName: true, createdAt: true } },
    },
  });

  res.status(201).json(product);
}));

marketplaceRouter.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.product.findFirst({
    where: { id: routeParam(req.params.id, 'id'), sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
  });
  if (!existing) throw new HttpError(404, 'Listing not found');

  const data = listingSchema.omit({ images: true }).partial().parse(req.body);
  const product = await prisma.product.update({ where: { id: existing.id }, data });
  res.json(product);
}));

marketplaceRouter.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.product.findFirst({
    where: { id: routeParam(req.params.id, 'id'), sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
  });
  if (!existing) throw new HttpError(404, 'Listing not found');
  await prisma.product.update({ where: { id: existing.id }, data: { status: 'ARCHIVED' } });
  res.status(204).send();
}));

marketplaceRouter.post('/sales/:orderItemId/ship', requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    trackingNumber: z.string().min(3).max(160),
    carrier: z.string().min(2).max(100),
  }).parse(req.body);

  const item = await prisma.orderItem.findFirst({
    where: { id: routeParam(req.params.orderItemId, 'orderItemId'), sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
  });
  if (!item) throw new HttpError(404, 'Sale item not found');

  const updated = await prisma.orderItem.update({
    where: { id: item.id },
    data: {
      sellerTrackingNumber: body.trackingNumber,
      sellerCarrier: body.carrier,
      sellerShippedAt: new Date(),
    },
  });
  await prisma.orderEvent.create({
    data: { orderId: item.orderId, type: 'MARKETPLACE_SELLER_SHIPPED', message: `${item.name} marked shipped by marketplace seller` },
  });
  res.json(updated);
}));
