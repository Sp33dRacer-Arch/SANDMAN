import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';

export const productsRouter = Router();

const listSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  source: z.enum(['DROPSHIP', 'MARKETPLACE']).optional(),
  condition: z.enum(['NEW', 'USED', 'REMANUFACTURED', 'OPEN_BOX']).optional(),
  vehicleVariantId: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest'),
});

productsRouter.get('/', asyncHandler(async (req, res) => {
  const q = listSchema.parse(req.query);
  const orderBy = q.sort === 'price_asc' ? { priceCents: 'asc' as const }
    : q.sort === 'price_desc' ? { priceCents: 'desc' as const }
    : q.sort === 'name' ? { name: 'asc' as const }
    : { createdAt: 'desc' as const };

  const where = {
    status: 'ACTIVE' as const,
    ...(q.source ? { sourceType: q.source } : {}),
    ...(q.condition ? { condition: q.condition } : {}),
    ...(q.q ? { OR: [
      { name: { contains: q.q, mode: 'insensitive' as const } },
      { sku: { contains: q.q, mode: 'insensitive' as const } },
      { manufacturerPn: { contains: q.q, mode: 'insensitive' as const } },
      { brand: { contains: q.q, mode: 'insensitive' as const } },
      { description: { contains: q.q, mode: 'insensitive' as const } },
    ] } : {}),
    ...(q.category ? { category: { slug: q.category } } : {}),
    ...(q.brand ? { brand: { equals: q.brand, mode: 'insensitive' as const } } : {}),
    ...(q.vehicleVariantId ? { OR: [
      { isUniversal: true },
      { fitments: { some: { vehicleVariantId: q.vehicleVariantId } } },
    ] } : {}),
    ...((q.minPrice !== undefined || q.maxPrice !== undefined) ? {
      priceCents: {
        ...(q.minPrice !== undefined ? { gte: Math.round(q.minPrice * 100) } : {}),
        ...(q.maxPrice !== undefined ? { lte: Math.round(q.maxPrice * 100) } : {}),
      },
    } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: {
        category: true,
        images: { orderBy: { position: 'asc' }, take: 2 },
        supplierLinks: { where: { active: true }, select: { stock: true } },
        seller: { select: { id: true, firstName: true, lastName: true, createdAt: true } },
      },
      orderBy,
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.json({ items, total, page: q.page, pages: Math.ceil(total / q.limit) });
}));

productsRouter.get('/categories', asyncHandler(async (_req, res) => {
  const categories = await prisma.category.findMany({
    where: { parentId: null },
    include: { children: true, _count: { select: { products: true } } },
    orderBy: { name: 'asc' },
  });
  res.json(categories);
}));

productsRouter.get('/:slug', asyncHandler(async (req, res) => {
  const vehicleVariantId = typeof req.query.vehicleVariantId === 'string' ? req.query.vehicleVariantId : undefined;
  const product = await prisma.product.findFirst({
    where: { slug: req.params.slug, status: 'ACTIVE' },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      fitments: { include: { vehicleVariant: { include: { model: { include: { make: true } } } } } },
      supplierLinks: {
        where: { active: true },
        include: { supplier: { select: { name: true, code: true } } },
        orderBy: { costCents: 'asc' },
      },
      seller: { select: { id: true, firstName: true, lastName: true, createdAt: true } },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');

  const fitsVehicle = !vehicleVariantId
    ? null
    : product.isUniversal || product.fitments.some(f => f.vehicleVariantId === vehicleVariantId);

  res.json({ ...product, fitsVehicle });
}));

productsRouter.get('/:id/fitment/:vehicleVariantId', asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, requiresFitment: true, isUniversal: true },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.isUniversal || !product.requiresFitment) return res.json({ compatible: true, reason: 'Universal fitment' });

  const match = await prisma.productFitment.findUnique({
    where: { productId_vehicleVariantId: { productId: req.params.id, vehicleVariantId: req.params.vehicleVariantId } },
  });
  res.json({ compatible: Boolean(match), notes: match?.notes ?? null });
}));
