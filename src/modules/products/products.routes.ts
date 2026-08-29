import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';

export const productsRouter = Router();

const queryBoolean = z.preprocess(value => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  source: z.enum(['DROPSHIP', 'MARKETPLACE']).optional(),
  condition: z.enum(['NEW', 'USED', 'REMANUFACTURED', 'OPEN_BOX']).optional(),
  vehicleVariantId: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  inStock: queryBoolean.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'name', 'popular']).default('newest'),
});

productsRouter.get('/', asyncHandler(async (req, res) => {
  const q = listSchema.parse(req.query);
  const orderBy = q.sort === 'price_asc' ? { priceCents: 'asc' as const }
    : q.sort === 'price_desc' ? { priceCents: 'desc' as const }
    : q.sort === 'name' ? { name: 'asc' as const }
    : q.sort === 'popular' ? [{ purchaseCount: 'desc' as const }, { viewCount: 'desc' as const }]
    : { createdAt: 'desc' as const };

  const and: any[] = [];
  if (q.q) {
    and.push({ OR: [
      { name: { contains: q.q, mode: 'insensitive' } },
      { sku: { contains: q.q, mode: 'insensitive' } },
      { manufacturerPn: { contains: q.q, mode: 'insensitive' } },
      { brand: { contains: q.q, mode: 'insensitive' } },
      { description: { contains: q.q, mode: 'insensitive' } },
      { category: { name: { contains: q.q, mode: 'insensitive' } } },
      { seller: { sellerProfile: { storeName: { contains: q.q, mode: 'insensitive' } } } },
      { fitments: { some: { vehicleVariant: { OR: [
        { engineCode: { contains: q.q, mode: 'insensitive' } },
        { engineName: { contains: q.q, mode: 'insensitive' } },
        { chassisCode: { contains: q.q, mode: 'insensitive' } },
        { model: { name: { contains: q.q, mode: 'insensitive' } } },
        { model: { make: { name: { contains: q.q, mode: 'insensitive' } } } },
      ] } } } },
    ] });
  }
  if (q.vehicleVariantId) and.push({ OR: [{ isUniversal: true }, { fitments: { some: { vehicleVariantId: q.vehicleVariantId } } }] });
  if (q.inStock) and.push({ OR: [
    { sourceType: 'MARKETPLACE', stockQuantity: { gt: 0 } },
    { sourceType: 'DROPSHIP', supplierLinks: { some: { active: true, OR: [{ availableStock: null }, { availableStock: { gt: 0 } }] } } },
  ] });

  const where = {
    status: 'ACTIVE' as const,
    ...(q.source ? { sourceType: q.source } : {}),
    ...(q.condition ? { condition: q.condition } : {}),
    ...(q.category ? { category: { slug: q.category } } : {}),
    ...(q.brand ? { brand: { equals: q.brand, mode: 'insensitive' as const } } : {}),
    ...((q.minPrice !== undefined || q.maxPrice !== undefined) ? {
      priceCents: {
        ...(q.minPrice !== undefined ? { gte: Math.round(q.minPrice * 100) } : {}),
        ...(q.maxPrice !== undefined ? { lte: Math.round(q.maxPrice * 100) } : {}),
      },
    } : {}),
    ...(and.length ? { AND: and } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: {
        category: true,
        images: { orderBy: { position: 'asc' }, take: 2 },
        supplierLinks: { where: { active: true }, select: { availableStock: true } },
        seller: { select: { id: true, firstName: true, lastName: true, createdAt: true, sellerProfile: true } },
        reviews: { where: { status: 'PUBLISHED' }, select: { rating: true } },
      },
      orderBy,
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.product.count({ where }),
  ]);

  const mapped = items.map(item => {
    const { supplierLinks, reviews, ...publicItem } = item;
    return {
      ...publicItem,
      rating: reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null,
      reviewCount: reviews.length,
      inStock: item.sourceType === 'MARKETPLACE' ? (item.stockQuantity ?? 0) > 0 : supplierLinks.some(link => link.availableStock === null || link.availableStock > 0),
    };
  });
  if (q.q) await prisma.searchEvent.create({ data: { query: q.q, resultsCount: total } }).catch(() => undefined);
  res.json({ items: mapped, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
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
    where: { slug: routeParam(req.params.slug, 'slug'), status: 'ACTIVE' },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      fitments: { include: { vehicleVariant: { include: { model: { include: { make: true } } } } } },
      // Public product responses use supplier stock only to derive availability.
      // Never expose supplier cost, raw feed data or supplier identifiers to buyers.
      supplierLinks: {
        where: { active: true },
        select: { availableStock: true },
      },
      seller: { select: { id: true, firstName: true, lastName: true, createdAt: true, sellerProfile: true } },
      reviews: {
        where: { status: 'PUBLISHED' },
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');

  const fitmentStatus = !vehicleVariantId ? 'UNCONFIRMED'
    : product.isUniversal || !product.requiresFitment ? 'FITS'
    : product.fitments.some(f => f.vehicleVariantId === vehicleVariantId) ? 'FITS'
    : 'DOES_NOT_FIT';
  const rating = product.reviews.length ? product.reviews.reduce((sum, review) => sum + review.rating, 0) / product.reviews.length : null;
  const inStock = product.sourceType === 'MARKETPLACE'
    ? (product.stockQuantity ?? 0) > 0
    : product.supplierLinks.some(link => link.availableStock === null || link.availableStock > 0);

  const { supplierLinks: _supplierLinks, ...publicProduct } = product;
  res.json({ ...publicProduct, fitmentStatus, fitsVehicle: fitmentStatus === 'UNCONFIRMED' ? null : fitmentStatus === 'FITS', rating, reviewCount: product.reviews.length, inStock });
}));

productsRouter.get('/:id/fitment/:vehicleVariantId', asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    select: { id: true, name: true, requiresFitment: true, isUniversal: true },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.isUniversal || !product.requiresFitment) return res.json({ compatible: true, status: 'FITS', reason: 'Universal fitment' });

  const match = await prisma.productFitment.findUnique({
    where: { productId_vehicleVariantId: { productId: routeParam(req.params.id, 'id'), vehicleVariantId: routeParam(req.params.vehicleVariantId, 'vehicleVariantId') } },
  });
  res.json({ compatible: Boolean(match), status: match ? 'FITS' : 'DOES_NOT_FIT', notes: match?.notes ?? null });
}));
