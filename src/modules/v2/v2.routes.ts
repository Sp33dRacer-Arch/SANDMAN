import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { optionalAuth, requireAuth, requireRole } from '../../middleware/auth';
import { evaluateFitment } from '../../services/fitment.service';
import { decodeVinWithNhtsa, resolveVinCandidates } from '../../services/vin.service';
import { scoreProductSearch } from '../../services/search-ranking.service';
import { deliveryWindow } from '../../services/shipping.service';
import { publicProduct } from '../../lib/public-product';

export const v2Router = Router();
const vinLookupLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

const optionalQueryBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  }
  return value;
}, z.boolean().optional());

const productInclude = {
  category: true,
  images: { orderBy: { position: 'asc' as const }, take: 1 },
  fitments: { select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true } },
  supplierLinks: {
    where: { active: true },
    select: {
      id: true,
      availableStock: true,
      stock: true,
      shippingCents: true,
      leadTimeDays: true,
      warehouseCountry: true,
      reliabilityScore: true,
      supplier: { select: { id: true, name: true, code: true, priority: true, active: true } },
    },
  },
};

function publicAvailability(product: any) {
  if (product.sourceType === 'MARKETPLACE') {
    return {
      inStock: (product.stockQuantity ?? 0) > 0,
      quantity: product.stockQuantity ?? 0,
      source: 'MARKETPLACE',
    };
  }
  const links = (product.supplierLinks ?? []).filter((link: any) => link.supplier?.active !== false);
  const inStock = links.some((link: any) => link.availableStock == null || link.availableStock > 0);
  const finite = links.map((link: any) => link.availableStock).filter((n: unknown): n is number => typeof n === 'number');
  return {
    inStock,
    quantity: finite.length ? finite.reduce((sum: number, value: number) => sum + value, 0) : null,
    source: 'SUPPLIER',
  };
}

v2Router.get('/catalog/status', asyncHandler(async (_req, res) => {
  const [makes, models, variants, products, activeProducts, verifiedFitments, fitments, suppliers] = await Promise.all([
    prisma.vehicleMake.count(),
    prisma.vehicleModel.count(),
    prisma.vehicleVariant.count(),
    prisma.product.count(),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.productFitment.count({ where: { verified: true } }),
    prisma.productFitment.count(),
    prisma.supplier.count({ where: { active: true } }),
  ]);
  res.json({ version: '2.3.0', vehicles: { makes, models, variants }, products: { total: products, active: activeProducts }, fitments: { total: fitments, verified: verifiedFitments }, activeSuppliers: suppliers });
}));



// VINs are submitted in the request body rather than the URL so reverse-proxy
// and access logs do not persist the full vehicle identifier in a request path.
v2Router.post('/vin/decode', vinLookupLimiter, asyncHandler(async (req, res) => {
  const { vin } = z.object({ vin: z.string().trim().min(1).max(32) }).parse(req.body);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const decoded = await decodeVinWithNhtsa(vin);
    const resolution = await resolveVinCandidates(decoded);
    // NHTSA can return partial data alongside decode warnings/errors. Keep those
    // candidates available for manual confirmation, but never call one an
    // automatic high-confidence match when the decoder itself reported an error.
    const matchedVariant = decoded.errorCode ? null : resolution.matchedVariant;
    res.json({
      provider: 'NHTSA_VPIC',
      decoded,
      candidates: resolution.candidates,
      matchedVariant,
      note: matchedVariant
        ? 'SANDMAN found a high-confidence catalogue match. Confirm the vehicle before saving it.'
        : decoded.errorCode
          ? 'VIN returned a decoder warning. Review the decoded details and manually confirm the correct SANDMAN catalogue variant.'
          : 'VIN decoded. Choose the correct SANDMAN catalogue variant before using fitment results.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'VIN lookup failed';
    throw new HttpError(message.includes('17 characters') ? 400 : 502, message);
  }
}));

v2Router.get('/shipping-estimate/:productId', asyncHandler(async (req, res) => {
  const productId = routeParam(req.params.productId, 'productId');
  const product = await prisma.product.findFirst({
    where: { id: productId, status: 'ACTIVE' },
    select: {
      id: true,
      sourceType: true,
      sellerShippingCents: true,
      shippingMinDays: true,
      shippingMaxDays: true,
      supplierLinks: {
        where: { active: true, supplier: { active: true } },
        select: { shippingCents: true, leadTimeDays: true, warehouseCountry: true, availableStock: true },
      },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  const viableSupplierLinks = product.supplierLinks.filter(link => link.availableStock == null || link.availableStock > 0);
  const window = deliveryWindow({
    productMinDays: product.shippingMinDays,
    productMaxDays: product.shippingMaxDays,
    supplierLeadTimes: viableSupplierLinks.map(link => link.leadTimeDays),
  });
  const shippingCents = product.sourceType === 'MARKETPLACE'
    ? product.sellerShippingCents
    : viableSupplierLinks.length
      ? Math.min(...viableSupplierLinks.map(link => link.shippingCents))
      : null;
  res.json({
    productId,
    ...window,
    shippingCents,
    warehouseCountries: [...new Set(viableSupplierLinks.map(link => link.warehouseCountry).filter(Boolean))],
    finalAtCheckout: true,
  });
}));

v2Router.get('/vehicles/picker', asyncHandler(async (req, res) => {
  const query = z.object({
    makeId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    year: z.coerce.number().int().min(1886).max(2200).optional(),
  }).parse(req.query);

  if (!query.makeId) {
    const makes = await prisma.vehicleMake.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } });
    return res.json({ step: 'MAKE', makes });
  }

  if (!query.modelId) {
    const models = await prisma.vehicleModel.findMany({ where: { makeId: query.makeId }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } });
    return res.json({ step: 'MODEL', models });
  }

  const variants = await prisma.vehicleVariant.findMany({
    where: { modelId: query.modelId, ...(query.year ? { yearStart: { lte: query.year }, yearEnd: { gte: query.year } } : {}) },
    include: { model: { include: { make: true } } },
    orderBy: [{ yearStart: 'desc' }, { engineCode: 'asc' }],
  });

  if (!query.year) {
    const years = new Set<number>();
    for (const variant of variants) {
      for (let year = variant.yearStart; year <= variant.yearEnd && year <= 2200; year += 1) years.add(year);
    }
    return res.json({ step: 'YEAR', years: [...years].sort((a, b) => b - a), variantCount: variants.length });
  }

  return res.json({ step: 'VARIANT', variants });
}));

v2Router.get('/vehicles/resolve', asyncHandler(async (req, res) => {
  const query = z.object({
    make: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
    year: z.coerce.number().int().min(1886).max(2200).optional(),
    engineCode: z.string().trim().max(80).optional(),
  }).parse(req.query);
  const rows = await prisma.vehicleVariant.findMany({
    where: {
      model: { name: { equals: query.model, mode: 'insensitive' }, make: { name: { equals: query.make, mode: 'insensitive' } } },
      ...(query.year ? { yearStart: { lte: query.year }, yearEnd: { gte: query.year } } : {}),
      ...(query.engineCode ? { engineCode: { equals: query.engineCode, mode: 'insensitive' } } : {}),
    },
    include: { model: { include: { make: true } } },
    take: 30,
  });
  res.json(rows);
}));

v2Router.get('/fitment/check', asyncHandler(async (req, res) => {
  const query = z.object({ productId: z.string().min(1), vehicleVariantId: z.string().min(1) }).parse(req.query);
  const [product, vehicle] = await Promise.all([
    prisma.product.findFirst({ where: { id: query.productId, status: 'ACTIVE' }, include: { fitments: { select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true } } } }),
    prisma.vehicleVariant.findUnique({ where: { id: query.vehicleVariantId }, include: { model: { include: { make: true } } } }),
  ]);
  if (!product) throw new HttpError(404, 'Product not found');
  if (!vehicle) throw new HttpError(404, 'Vehicle variant not found');
  res.json({ productId: product.id, vehicle, ...evaluateFitment(product, vehicle.id) });
}));

v2Router.post('/fitment/check-batch', asyncHandler(async (req, res) => {
  const body = z.object({ productIds: z.array(z.string().min(1)).min(1).max(100), vehicleVariantId: z.string().min(1) }).parse(req.body);
  const products = await prisma.product.findMany({
    where: { id: { in: body.productIds }, status: 'ACTIVE' },
    select: { id: true, requiresFitment: true, isUniversal: true, fitments: { select: { vehicleVariantId: true, verified: true, source: true, notes: true, verifiedAt: true } } },
  });
  res.json(products.map(product => ({ productId: product.id, ...evaluateFitment(product, body.vehicleVariantId) })));
}));

v2Router.get('/search', asyncHandler(async (req, res) => {
  const query = z.object({
    q: z.string().trim().min(1).max(200),
    vehicleVariantId: z.string().min(1).optional(),
    category: z.string().optional(),
    brand: z.string().optional(),
    inStock: optionalQueryBoolean,
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }).parse(req.query);

  const products = await prisma.product.findMany({
    where: {
      status: 'ACTIVE',
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.brand ? { brand: { equals: query.brand, mode: 'insensitive' } } : {}),
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { sku: { contains: query.q, mode: 'insensitive' } },
        { manufacturerPn: { contains: query.q, mode: 'insensitive' } },
        { brand: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        { category: { name: { contains: query.q, mode: 'insensitive' } } },
        { fitments: { some: { vehicleVariant: { OR: [
          { engineCode: { contains: query.q, mode: 'insensitive' } },
          { engineName: { contains: query.q, mode: 'insensitive' } },
          { chassisCode: { contains: query.q, mode: 'insensitive' } },
          { model: { name: { contains: query.q, mode: 'insensitive' } } },
          { model: { make: { name: { contains: query.q, mode: 'insensitive' } } } },
        ] } } } },
      ],
    },
    include: productInclude,
    orderBy: [{ purchaseCount: 'desc' }, { viewCount: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(query.limit * 8, 250),
  });

  const vehicles = await prisma.vehicleVariant.findMany({
    where: { OR: [
      { engineCode: { contains: query.q, mode: 'insensitive' } },
      { engineName: { contains: query.q, mode: 'insensitive' } },
      { chassisCode: { contains: query.q, mode: 'insensitive' } },
      { model: { name: { contains: query.q, mode: 'insensitive' } } },
      { model: { make: { name: { contains: query.q, mode: 'insensitive' } } } },
    ] },
    include: { model: { include: { make: true } } },
    take: 12,
  });

 let shaped = products.map((product: any) => {
  const { supplierLinks: _supplierLinks, ...productWithoutSupplierData } = product;
  return {
    ...publicProduct(productWithoutSupplierData),
    purchaseCount: product.purchaseCount ?? 0,
    viewCount: product.viewCount ?? 0,
    availability: publicAvailability(product),
    fitment: evaluateFitment(product, query.vehicleVariantId),
    searchScore: scoreProductSearch(product, query.q),
  };
});
  if (query.inStock) shaped = shaped.filter(product => product.availability.inStock);
  shaped.sort((a, b) => b.searchScore - a.searchScore || b.purchaseCount - a.purchaseCount || b.viewCount - a.viewCount);
  res.json({ products: shaped.slice(0, query.limit), vehicles });
}));

v2Router.get('/products/:id/supplier-options', asyncHandler(async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: routeParam(req.params.id, 'id'), status: 'ACTIVE' },
    include: {
      supplierLinks: {
        where: { active: true, supplier: { active: true } },
        select: { availableStock: true, shippingCents: true, leadTimeDays: true, warehouseCountry: true },
        orderBy: [{ supplier: { priority: 'asc' } }, { shippingCents: 'asc' }],
      },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.sourceType !== 'DROPSHIP') return res.json([]);
  // This is a buyer-facing availability endpoint. Keep supplier identity,
  // internal link IDs, exact stock, reliability scoring and sync timestamps private.
  res.json(product.supplierLinks.map(link => ({
    availability: link.availableStock == null ? 'CHECK_WITH_SUPPLIER' : link.availableStock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
    shippingCents: link.shippingCents,
    leadTimeDays: link.leadTimeDays,
    warehouseCountry: link.warehouseCountry,
  })));
}));

v2Router.get('/checkout/preflight', requireAuth, asyncHandler(async (req, res) => {
  const cart = await prisma.cart.findUnique({
    where: { userId: req.auth!.userId },
    include: { items: { include: { product: { include: productInclude } } } },
  });
  if (!cart || !cart.items.length) return res.json({ ready: false, issues: [{ code: 'EMPTY_CART', message: 'Your cart is empty' }], items: [] });

  const issues: Array<{ code: string; message: string; productId?: string }> = [];
  const items = cart.items.map((item: any) => {
    const fitment = evaluateFitment(item.product, item.fitmentVehicleVariantId);
    const availability = publicAvailability(item.product);
    if (item.product.requiresFitment && !item.product.isUniversal && !item.fitmentVehicleVariantId) issues.push({ code: 'VEHICLE_REQUIRED', message: `${item.product.name} requires a vehicle selection`, productId: item.productId });
    if (item.product.requiresFitment && !item.product.isUniversal && item.fitmentVehicleVariantId && fitment.status === 'UNKNOWN') issues.push({ code: 'FITMENT_UNVERIFIED', message: `${item.product.name} has no fitment record for the selected vehicle`, productId: item.productId });
    if (fitment.status === 'DOES_NOT_FIT') issues.push({ code: 'FITMENT_CONFLICT', message: `${item.product.name} is explicitly incompatible with the selected vehicle`, productId: item.productId });
    if (!availability.inStock) issues.push({ code: 'OUT_OF_STOCK', message: `${item.product.name} is currently unavailable`, productId: item.productId });
    if (availability.quantity != null && availability.quantity < item.quantity) issues.push({ code: 'INSUFFICIENT_STOCK', message: `${item.product.name} has less stock than the quantity in your cart`, productId: item.productId });
    return { id: item.id, productId: item.productId, name: item.product.name, quantity: item.quantity, fitment, availability };
  });
  res.json({ ready: issues.length === 0, issues, items });
}));

v2Router.post('/requests/vehicle', optionalAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    email: z.string().email().optional(),
    make: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
    year: z.number().int().min(1886).max(2200).optional(),
    trim: z.string().trim().max(120).optional(),
    engineCode: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).parse(req.body);
  if (!req.auth && !body.email) throw new HttpError(400, 'Email is required when you are not logged in');
  const request = await prisma.vehicleRequest.create({ data: { ...body, userId: req.auth?.userId, email: body.email ?? req.auth?.email } });
  res.status(201).json(request);
}));

v2Router.post('/requests/part', optionalAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    email: z.string().email().optional(),
    vehicleVariantId: z.string().min(1).optional(),
    partName: z.string().trim().min(2).max(180),
    oemNumber: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(3000).optional(),
    budgetCents: z.number().int().positive().max(100_000_000).optional(),
  }).parse(req.body);
  if (!req.auth && !body.email) throw new HttpError(400, 'Email is required when you are not logged in');
  if (body.vehicleVariantId && !(await prisma.vehicleVariant.findUnique({ where: { id: body.vehicleVariantId }, select: { id: true } }))) throw new HttpError(404, 'Vehicle variant not found');
  const request = await prisma.partRequest.create({ data: { ...body, userId: req.auth?.userId, email: body.email ?? req.auth?.email } });
  res.status(201).json(request);
}));

v2Router.get('/requests/mine', requireAuth, asyncHandler(async (req, res) => {
  const [vehicles, parts] = await Promise.all([
    prisma.vehicleRequest.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: 'desc' } }),
    prisma.partRequest.findMany({ where: { userId: req.auth!.userId }, include: { vehicleVariant: { include: { model: { include: { make: true } } } } }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ vehicleRequests: vehicles, partRequests: parts });
}));

v2Router.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const [garageCount, orderCount, wishlistCount, buildCount, partRequestCount, vehicleRequestCount, primary, recentOrders] = await Promise.all([
    prisma.garageVehicle.count({ where: { userId: req.auth!.userId } }),
    prisma.order.count({ where: { userId: req.auth!.userId } }),
    prisma.wishlistItem.count({ where: { userId: req.auth!.userId } }),
    prisma.build.count({ where: { userId: req.auth!.userId } }),
    prisma.partRequest.count({ where: { userId: req.auth!.userId, status: { in: ['OPEN', 'REVIEWING', 'SOURCED'] } } }),
    prisma.vehicleRequest.count({ where: { userId: req.auth!.userId, status: { in: ['OPEN', 'REVIEWING', 'SOURCED'] } } }),
    prisma.garageVehicle.findFirst({ where: { userId: req.auth!.userId, isPrimary: true }, include: { vehicleVariant: { include: { model: { include: { make: true } } } } } }),
    prisma.order.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: 'desc' }, take: 5, select: { orderNumber: true, status: true, paymentStatus: true, totalCents: true, currency: true, createdAt: true } }),
  ]);
  res.json({ counts: { garage: garageCount, orders: orderCount, wishlist: wishlistCount, builds: buildCount, openRequests: partRequestCount + vehicleRequestCount }, primaryVehicle: primary, recentOrders });
}));

const advisorBody = z.object({
  vehicleVariantId: z.string().min(1),
  targetPowerHp: z.number().int().min(50).max(5000).optional(),
  budgetCents: z.number().int().positive().max(100_000_000).optional(),
  goal: z.enum(['DAILY', 'RELIABILITY', 'STREET', 'TRACK']).default('STREET'),
});

v2Router.post('/build-advisor', asyncHandler(async (req, res) => {
  const body = advisorBody.parse(req.body);
  const vehicle = await prisma.vehicleVariant.findUnique({ where: { id: body.vehicleVariantId }, include: { model: { include: { make: true } } } });
  if (!vehicle) throw new HttpError(404, 'Vehicle variant not found');

  const priorityByGoal: Record<string, string[]> = {
    DAILY: ['maintenance', 'cooling', 'intake', 'brake'],
    RELIABILITY: ['maintenance', 'cooling', 'oil', 'brake', 'fuel'],
    STREET: ['intake', 'exhaust', 'cooling', 'fuel', 'suspension', 'brake'],
    TRACK: ['brake', 'cooling', 'suspension', 'oil', 'fuel', 'intake', 'exhaust'],
  };
  const priorities = priorityByGoal[body.goal] ?? priorityByGoal.STREET!;
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', OR: [{ isUniversal: true }, { fitments: { some: { vehicleVariantId: vehicle.id } } }] },
    include: productInclude,
    orderBy: [{ purchaseCount: 'desc' }, { viewCount: 'desc' }],
    take: 120,
  });

  const recommendations = priorities.map(keyword => {
    const matches = products.filter((product: any) => `${product.category?.name ?? ''} ${product.name}`.toLowerCase().includes(keyword)).slice(0, 4);
    return { category: keyword, products: matches.map((product: any) => ({ id: product.id, slug: product.slug, name: product.name, priceCents: product.priceCents, currency: product.currency, fitment: evaluateFitment(product, vehicle.id), availability: publicAvailability(product) })) };
  });
  const flat = recommendations.flatMap(group => group.products);
  const suggestedCartCents = flat.reduce((sum, product) => sum + product.priceCents, 0);
  res.json({
    vehicle,
    goal: body.goal,
    targetPowerHp: body.targetPowerHp ?? null,
    budgetCents: body.budgetCents ?? null,
    recommendations,
    suggestedCartCents,
    budgetDeltaCents: body.budgetCents == null ? null : body.budgetCents - suggestedCartCents,
    planningOnly: true,
    safetyNote: 'Power targets and modification stages require vehicle-specific professional validation. SANDMAN only recommends catalogue parts with compatible or universal fitment records.',
  });
}));

v2Router.get('/admin/catalog-health', requireAuth, requireRole('ADMIN', 'STAFF'), asyncHandler(async (_req, res) => {
  const [unverifiedFitments, productsWithoutImages, dropshipWithoutSupplier, activeWithoutFitment, openVehicleRequests, openPartRequests] = await Promise.all([
    prisma.productFitment.count({ where: { verified: false } }),
    prisma.product.count({ where: { status: 'ACTIVE', images: { none: {} } } }),
    prisma.product.count({ where: { status: 'ACTIVE', sourceType: 'DROPSHIP', supplierLinks: { none: { active: true } } } }),
    prisma.product.count({ where: { status: 'ACTIVE', requiresFitment: true, isUniversal: false, fitments: { none: {} } } }),
    prisma.vehicleRequest.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
    prisma.partRequest.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
  ]);
  res.json({ unverifiedFitments, productsWithoutImages, dropshipWithoutSupplier, activeProductsWithoutFitment: activeWithoutFitment, openVehicleRequests, openPartRequests });
}));

v2Router.get('/admin/requests', requireAuth, requireRole('ADMIN', 'STAFF'), asyncHandler(async (_req, res) => {
  const [vehicles, parts] = await Promise.all([
    prisma.vehicleRequest.findMany({ include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.partRequest.findMany({ include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, vehicleVariant: { include: { model: { include: { make: true } } } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ]);
  res.json({ vehicleRequests: vehicles, partRequests: parts });
}));

v2Router.patch('/admin/requests/:kind/:id', requireAuth, requireRole('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const kind = z.enum(['vehicle', 'part']).parse(req.params.kind);
  const id = routeParam(req.params.id, 'id');
  const body = z.object({ status: z.enum(['OPEN', 'REVIEWING', 'SOURCED', 'CLOSED']) }).parse(req.body);
  if (kind === 'vehicle') return res.json(await prisma.vehicleRequest.update({ where: { id }, data: body }));
  return res.json(await prisma.partRequest.update({ where: { id }, data: body }));
}));
