import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { evaluateFitment } from '../../services/fitment.service';
import { scoreProductSearch } from '../../services/search-ranking.service';
import { publicProduct } from '../../lib/public-product';

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

  const listInclude = {
    category: true,
    images: { orderBy: { position: 'asc' as const }, take: 1 },
    supplierLinks: { where: { active: true }, select: { availableStock: true } },
    seller: { select: { id: true, firstName: true, lastName: true, createdAt: true, sellerProfile: true } },
    // Listing cards need only the selected vehicle's evidence, never every fitment row.
    fitments: {
      where: { vehicleVariantId: q.vehicleVariantId ?? '__NO_SELECTED_VEHICLE__' },
      select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true },
    },
  };

  // Guarantee that exact part-number/name matches are surfaced on page one even
  // when the product is older than newer broad text matches. The rest of each
  // default-search page is then relevance-ranked locally.
  const shouldRankSearch = Boolean(q.q && q.sort === 'newest');
  const exactIdRows = shouldRankSearch ? await prisma.product.findMany({
    where: {
      AND: [
        where,
        { OR: [
          { sku: { equals: q.q!, mode: 'insensitive' } },
          { manufacturerPn: { equals: q.q!, mode: 'insensitive' } },
          { name: { equals: q.q!, mode: 'insensitive' } },
        ] },
      ],
    },
    select: { id: true },
    take: q.limit,
  }) : [];
  const exactIds = exactIdRows.map(row => row.id);
  const regularWhere = exactIds.length ? { AND: [where, { id: { notIn: exactIds } }] } : where;
  const regularSkip = shouldRankSearch && q.page > 1
    ? Math.max(0, (q.page - 1) * q.limit - exactIds.length)
    : (q.page - 1) * q.limit;
  const regularTake = shouldRankSearch && q.page === 1 ? Math.max(0, q.limit - exactIds.length) : q.limit;

  const exactItems = shouldRankSearch && q.page === 1 && exactIds.length ? await prisma.product.findMany({
    where: { AND: [where, { id: { in: exactIds } }] },
    include: listInclude,
  }) : [];
  const [regularItems, total] = await Promise.all([
    regularTake > 0 ? prisma.product.findMany({
      where: regularWhere,
      include: listInclude,
      orderBy,
      skip: regularSkip,
      take: regularTake,
    }) : Promise.resolve([]),
    prisma.product.count({ where }),
  ]);
  const items = [...exactItems, ...regularItems];

  const ratingRows = items.length ? await prisma.productReview.groupBy({
    by: ['productId'],
    where: { productId: { in: items.map(item => item.id) }, status: 'PUBLISHED' },
    _avg: { rating: true },
    _count: { rating: true },
  }) : [];
  const ratingMap = new Map(ratingRows.map(row => [row.productId, { rating: row._avg.rating ?? null, count: row._count.rating }]));

  const mapped = items.map(item => {
    const { supplierLinks, fitments, ...itemWithoutSupplierData } = item;
    const publicItem = publicProduct(itemWithoutSupplierData);
    const fitment = q.vehicleVariantId ? evaluateFitment({ ...item, fitments }, q.vehicleVariantId) : null;
    const review = ratingMap.get(item.id);
    return {
      ...publicItem,
      rating: review?.rating ?? null,
      reviewCount: review?.count ?? 0,
      inStock: item.sourceType === 'MARKETPLACE' ? (item.stockQuantity ?? 0) > 0 : supplierLinks.some(link => link.availableStock === null || link.availableStock > 0),
      fitmentStatus: fitment?.status ?? null,
      fitmentVerified: fitment?.verified ?? false,
    };
  });
  if (shouldRankSearch && q.q) {
    mapped.sort((a, b) => scoreProductSearch(b, q.q!) - scoreProductSearch(a, q.q!) || b.purchaseCount - a.purchaseCount || b.viewCount - a.viewCount);
  }
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
        include: { user: { select: { id: true, firstName: true, lastName: true } }, orderItem: { select: { fitmentSnapshot: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  const reviewAggregate = await prisma.productReview.aggregate({ where: { productId: product.id, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { rating: true } });

  const reviewVariantIds = [...new Set(product.reviews.map(review => {
    const snapshot = review.orderItem?.fitmentSnapshot as { vehicleVariantId?: string } | null;
    return snapshot?.vehicleVariantId;
  }).filter((id): id is string => Boolean(id)))];
  const reviewVehicles = reviewVariantIds.length ? await prisma.vehicleVariant.findMany({
    where: { id: { in: reviewVariantIds } },
    select: { id: true, yearStart: true, yearEnd: true, trim: true, engineCode: true, model: { select: { name: true, make: { select: { name: true } } } } },
  }) : [];
  const reviewVehicleMap = new Map(reviewVehicles.map(vehicle => [vehicle.id, vehicle]));
  const publicReviews = product.reviews.map(review => {
    const snapshot = review.orderItem?.fitmentSnapshot as { vehicleVariantId?: string } | null;
    return {
      id: review.id,
      rating: review.rating,
      title: review.title,
      body: review.body,
      mediaUrls: review.mediaUrls,
      verifiedPurchase: review.verifiedPurchase,
      createdAt: review.createdAt,
      user: { firstName: review.user.firstName, lastName: review.user.lastName },
      vehicle: snapshot?.vehicleVariantId ? reviewVehicleMap.get(snapshot.vehicleVariantId) ?? null : null,
    };
  });

  const fitment = evaluateFitment(product, vehicleVariantId);
  const fitmentStatus = fitment.status;
  const rating = reviewAggregate._avg.rating ?? null;
  const inStock = product.sourceType === 'MARKETPLACE'
    ? (product.stockQuantity ?? 0) > 0
    : product.supplierLinks.some(link => link.availableStock === null || link.availableStock > 0);

  const { supplierLinks: _supplierLinks, reviews: _reviews, ...productWithoutSupplierData } = product;
  const safeProduct = publicProduct(productWithoutSupplierData);
  const safeSeller = safeProduct.seller ? {
    id: safeProduct.seller.id,
    firstName: safeProduct.seller.firstName,
    lastName: safeProduct.seller.lastName,
    createdAt: safeProduct.seller.createdAt,
    sellerProfile: safeProduct.seller.sellerProfile ? {
      storeName: safeProduct.seller.sellerProfile.storeName,
      bio: safeProduct.seller.sellerProfile.bio,
      location: safeProduct.seller.sellerProfile.location,
      verified: safeProduct.seller.sellerProfile.verified,
      responseTimeHours: safeProduct.seller.sellerProfile.responseTimeHours,
      totalSales: safeProduct.seller.sellerProfile.totalSales,
      ratingAverage: safeProduct.seller.sellerProfile.ratingAverage,
      ratingCount: safeProduct.seller.sellerProfile.ratingCount,
      createdAt: safeProduct.seller.sellerProfile.createdAt,
    } : null,
  } : null;
  res.json({ ...safeProduct, seller: safeSeller, reviews: publicReviews, fitmentStatus, fitmentVerified: fitment.verified, fitmentReason: fitment.reason, fitsVehicle: fitment.fits, rating, reviewCount: reviewAggregate._count.rating, inStock });
}));

productsRouter.get('/:id/fitment/:vehicleVariantId', asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    select: { id: true, name: true, requiresFitment: true, isUniversal: true, fitments: { select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true } } },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  const result = evaluateFitment(product, routeParam(req.params.vehicleVariantId, 'vehicleVariantId'));
  res.json({ compatible: result.fits, status: result.status, verified: result.verified, reason: result.reason, evidence: result.evidence });
}));
