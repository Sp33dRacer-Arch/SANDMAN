import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { finalizePaidOrder } from '../../services/payment-finalization.service';
import { recomputeOrderFulfillmentStatus } from '../../services/order-lifecycle.service';
import { cancelUnpaidCheckout } from '../../services/checkout-reservation.service';
import { processReadyStripeMarketplacePayouts } from '../../services/marketplace-payout.service';
import { env } from '../../config/env';
import { setSupplierReportedStock } from '../../services/supplier-inventory.service';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

adminRouter.get('/settings', asyncHandler(async (_req, res) => {
  const [sessions, paidPayouts, payoutGroups] = await Promise.all([
    prisma.authSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.sellerPayout.aggregate({ where: { status: 'PAID' }, _sum: { amountCents: true, platformFeeCents: true }, _count: true }),
    prisma.sellerPayout.groupBy({ by: ['status'], _sum: { amountCents: true }, _count: true }),
  ]);
  const payoutByStatus = Object.fromEntries(payoutGroups.map(group => [group.status, group._sum.amountCents ?? 0]));
  res.json({
    environment: env.NODE_ENV,
    appUrl: env.APP_URL,
    apiUrl: env.API_URL,
    sessionDays: env.SESSION_DAYS,
    activePersistentSessions: sessions,
    payments: {
      stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY),
      paypal: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
      bankTransfer: Boolean(env.BANK_TRANSFER_INSTRUCTIONS),
    },
    marketplace: {
      commissionPercent: env.MARKETPLACE_COMMISSION_PERCENT,
      payoutProvider: 'Stripe Connect',
      // Backwards-compatible fields now mean actually-paid money only.
      payoutCount: paidPayouts._count,
      sellerPayoutCents: paidPayouts._sum.amountCents ?? 0,
      platformFeeCents: paidPayouts._sum.platformFeeCents ?? 0,
      paidPayoutCount: paidPayouts._count,
      paidSellerPayoutCents: paidPayouts._sum.amountCents ?? 0,
      paidPlatformFeeCents: paidPayouts._sum.platformFeeCents ?? 0,
      pendingSellerPayoutCents: payoutByStatus.PENDING ?? 0,
      readySellerPayoutCents: payoutByStatus.READY ?? 0,
      processingSellerPayoutCents: payoutByStatus.PROCESSING ?? 0,
      blockedSellerPayoutCents: payoutByStatus.BLOCKED ?? 0,
      failedSellerPayoutCents: payoutByStatus.FAILED ?? 0,
    },
    syncee: {
      mode: env.SYNCEE_MODE,
      ordersUrl: env.SYNCEE_ORDERS_URL,
      customRetailerApiAvailable: false,
    },
  });
}));

adminRouter.get('/dashboard', asyncHandler(async (_req, res) => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setUTCHours(0, 0, 0, 0);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);

  const [
    orders,
    paidRevenue,
    products,
    suppliers,
    failedFulfillments,
    customers,
    pendingOrders,
    recentPaidOrders,
    recentOrders,
    lowStockLinks,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.aggregate({ where: { paymentStatus: 'PAID' }, _sum: { totalCents: true } }),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.supplier.count({ where: { active: true } }),
    prisma.fulfillment.count({ where: { status: 'FAILED' } }),
    prisma.user.count({ where: { role: 'CUSTOMER', isActive: true } }),
    prisma.order.count({ where: { status: { in: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SUBMITTED_TO_SUPPLIER', 'PARTIALLY_FULFILLED'] } } }),
    prisma.order.findMany({
      where: { paymentStatus: 'PAID', createdAt: { gte: sevenDaysAgo } },
      select: { totalCents: true, createdAt: true, items: { select: { quantity: true, supplierCostCents: true } } },
    }),
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true,
        orderNumber: true,
        email: true,
        status: true,
        paymentStatus: true,
        totalCents: true,
        currency: true,
        createdAt: true,
      },
    }),
    prisma.supplierProduct.findMany({
      where: { active: true, availableStock: { not: null, lte: 10 } },
      include: { product: { select: { id: true, name: true, sku: true } }, supplier: { select: { name: true } } },
      orderBy: { availableStock: 'asc' },
      take: 8,
    }),
  ]);

  const dailyMap = new Map<string, { revenueCents: number; orders: number }>();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(sevenDaysAgo);
    d.setUTCDate(d.getUTCDate() + i);
    dailyMap.set(dayKey(d), { revenueCents: 0, orders: 0 });
  }

  let recentProfitCents = 0;
  for (const order of recentPaidOrders) {
    const key = dayKey(order.createdAt);
    const row = dailyMap.get(key);
    if (row) {
      row.revenueCents += order.totalCents;
      row.orders += 1;
    }
    // supplierCostCents is already stored as the total landed cost for the order line.
    const supplierCost = order.items.reduce((sum, item) => sum + (item.supplierCostCents ?? 0), 0);
    recentProfitCents += Math.max(0, order.totalCents - supplierCost);
  }

  res.json({
    orders,
    revenueCents: paidRevenue._sum.totalCents ?? 0,
    activeProducts: products,
    activeSuppliers: suppliers,
    failedFulfillments,
    customers,
    pendingOrders,
    recentProfitCents,
    sales7d: [...dailyMap.entries()].map(([date, value]) => ({ date, ...value })),
    recentOrders,
    lowStock: lowStockLinks.map(link => ({
      id: link.id,
      productId: link.product.id,
      product: link.product.name,
      sku: link.product.sku,
      supplier: link.supplier.name,
      stock: link.availableStock,
      reportedStock: link.stock,
      reservedStock: link.reservedStock,
    })),
  });
}));

adminRouter.get('/products', asyncHandler(async (req, res) => {
  const query = z.object({
    q: z.string().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    categoryId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(req.query);

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.q ? {
      OR: [
        { name: { contains: query.q, mode: 'insensitive' as const } },
        { sku: { contains: query.q, mode: 'insensitive' as const } },
        { brand: { contains: query.q, mode: 'insensitive' as const } },
        { manufacturerPn: { contains: query.q, mode: 'insensitive' as const } },
      ],
    } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: {
        category: true,
        images: { orderBy: { position: 'asc' }, take: 1 },
        supplierLinks: { where: { active: true }, include: { supplier: { select: { id: true, name: true } } } },
        _count: { select: { fitments: true } },
      },
      orderBy: { updatedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.json({ items, total, page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)) });
}));

adminRouter.get('/products/:id', asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      fitments: { include: { vehicleVariant: { include: { model: { include: { make: true } } } } } },
      supplierLinks: { include: { supplier: true }, orderBy: { costCents: 'asc' } },
    },
  });
  if (!product) throw new HttpError(404, 'Product not found');
  res.json(product);
}));

const productSchema = z.object({
  sku: z.string().min(1).max(80),
  slug: z.string().min(1).max(160),
  name: z.string().min(2).max(240),
  brand: z.string().max(120).optional(),
  manufacturerPn: z.string().max(120).optional(),
  description: z.string().min(10),
  shortDesc: z.string().max(500).optional(),
  categoryId: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  compareAtCents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  requiresFitment: z.boolean().default(true),
  isUniversal: z.boolean().default(false),
  warrantyText: z.string().max(1000).optional(),
  returnDays: z.number().int().min(0).max(365).optional(),
  installDifficulty: z.string().max(80).optional(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  videoUrl: z.string().url().optional(),
  shippingMinDays: z.number().int().min(0).max(365).optional(),
  shippingMaxDays: z.number().int().min(0).max(365).optional(),
  seoTitle: z.string().max(160).optional(),
  seoDescription: z.string().max(320).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('DRAFT'),
  images: z.array(z.object({ url: z.string().url(), alt: z.string().optional(), position: z.number().int().default(0) })).default([]),
});

adminRouter.post('/products', asyncHandler(async (req, res) => {
  const data = productSchema.parse(req.body);
  const { images, ...productData } = data;
  const product = await prisma.product.create({
    data: {
      ...productData,
      images: { create: images },
    },
    include: { images: true, category: true },
  });
  res.status(201).json(product);
}));

adminRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  const data = productSchema.omit({ images: true }).partial().parse(req.body);
  const product = await prisma.product.update({ where: { id: routeParam(req.params.id, 'id') }, data });
  res.json(product);
}));

adminRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  await prisma.product.update({ where: { id: routeParam(req.params.id, 'id') }, data: { status: 'ARCHIVED' } });
  res.status(204).send();
}));

adminRouter.get('/categories', asyncHandler(async (_req, res) => {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { products: true } } },
    orderBy: { name: 'asc' },
  });
  res.json(categories);
}));

adminRouter.post('/categories', asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2).max(120),
    slug: z.string().min(2).max(120),
    description: z.string().max(500).optional(),
    parentId: z.string().optional(),
  }).parse(req.body);
  res.status(201).json(await prisma.category.create({ data }));
}));

adminRouter.get('/orders', asyncHandler(async (req, res) => {
  const query = z.object({
    status: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);

  const orders = await prisma.order.findMany({
    where: {
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.q ? { OR: [
        { orderNumber: { contains: query.q, mode: 'insensitive' } },
        { email: { contains: query.q, mode: 'insensitive' } },
      ] } : {}),
    },
    include: {
      items: true,
      fulfillments: { include: { supplier: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });
  res.json(orders);
}));

adminRouter.get('/orders/:id', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    include: {
      items: true,
      fulfillments: { include: { supplier: true } },
      events: { orderBy: { createdAt: 'desc' } },
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  res.json(order);
}));

adminRouter.post('/orders/:id/mark-paid', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: routeParam(req.params.id, 'id') } });
  if (!order) throw new HttpError(404, 'Order not found');
  if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) {
    throw new HttpError(409, 'A refunded order cannot be marked paid again.');
  }
  if (order.paymentStatus !== 'PAID') {
    await prisma.orderEvent.create({ data: { orderId: order.id, type: 'ADMIN_MARKED_PAID', message: 'Order manually marked paid by staff' } });
  }
  await finalizePaidOrder({ orderId: order.id, provider: 'manual', message: 'Order manually marked paid by staff' });
  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { fulfillments: true, sellerPayouts: true } });
  res.json({ success: true, order: updated });
}));

adminRouter.patch('/orders/:id/status', asyncHandler(async (req, res) => {
  const data = z.object({
    status: z.enum(['PROCESSING', 'SUBMITTED_TO_SUPPLIER', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'FAILED']),
  }).parse(req.body);
  const id = routeParam(req.params.id, 'id');
  const current = await prisma.order.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, 'Order not found');

  if (data.status === 'CANCELLED') {
    if (!['PENDING', 'FAILED'].includes(current.paymentStatus)) {
      throw new HttpError(409, 'Captured/refunded orders cannot be cancelled with a status edit. Use the refund flow when applicable.');
    }
    await cancelUnpaidCheckout(id);
    return res.json(await prisma.order.findUnique({ where: { id } }));
  }
  if (data.status === 'FULFILLED' && !['PAID', 'PARTIALLY_REFUNDED'].includes(current.paymentStatus)) {
    throw new HttpError(409, 'An unpaid order cannot be fulfilled');
  }

  const order = await prisma.order.update({ where: { id }, data: { status: data.status } });
  await prisma.orderEvent.create({ data: { orderId: order.id, type: 'ADMIN_STATUS_CHANGED', message: `Order status changed to ${data.status}` } });
  if (['PROCESSING', 'SUBMITTED_TO_SUPPLIER', 'PARTIALLY_FULFILLED', 'FULFILLED'].includes(data.status)) {
    await recomputeOrderFulfillmentStatus(id);
  }
  res.json(await prisma.order.findUnique({ where: { id } }));
}));

adminRouter.get('/customers', asyncHandler(async (req, res) => {
  const query = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
  const users = await prisma.user.findMany({
    where: {
      role: 'CUSTOMER',
      ...(query.q ? { OR: [
        { email: { contains: query.q, mode: 'insensitive' } },
        { firstName: { contains: query.q, mode: 'insensitive' } },
        { lastName: { contains: query.q, mode: 'insensitive' } },
      ] } : {}),
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      isActive: true,
      createdAt: true,
      _count: { select: { orders: true, garage: true } },
      orders: { where: { paymentStatus: 'PAID' }, select: { totalCents: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });
  res.json(users.map(user => ({
    ...user,
    totalSpentCents: user.orders.reduce((sum, order) => sum + order.totalCents, 0),
    orders: undefined,
  })));
}));

adminRouter.get('/vehicles', asyncHandler(async (req, res) => {
  const query = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(300).default(100) }).parse(req.query);
  const variants = await prisma.vehicleVariant.findMany({
    where: query.q ? {
      OR: [
        { engineCode: { contains: query.q, mode: 'insensitive' } },
        { engineName: { contains: query.q, mode: 'insensitive' } },
        { chassisCode: { contains: query.q, mode: 'insensitive' } },
        { model: { name: { contains: query.q, mode: 'insensitive' } } },
        { model: { make: { name: { contains: query.q, mode: 'insensitive' } } } },
      ],
    } : undefined,
    include: { model: { include: { make: true } }, _count: { select: { productFitments: true, garageVehicles: true } } },
    orderBy: [{ model: { make: { name: 'asc' } } }, { model: { name: 'asc' } }, { yearStart: 'desc' }],
    take: query.limit,
  });
  res.json(variants);
}));

adminRouter.get('/vehicle-models', asyncHandler(async (_req, res) => {
  const models = await prisma.vehicleModel.findMany({ include: { make: true }, orderBy: [{ make: { name: 'asc' } }, { name: 'asc' }] });
  res.json(models);
}));

adminRouter.post('/vehicle-makes', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(2).max(80), slug: z.string().min(2).max(80) }).parse(req.body);
  res.status(201).json(await prisma.vehicleMake.create({ data }));
}));

adminRouter.post('/vehicle-models', asyncHandler(async (req, res) => {
  const data = z.object({ makeId: z.string().min(1), name: z.string().min(1).max(120), slug: z.string().min(1).max(120) }).parse(req.body);
  res.status(201).json(await prisma.vehicleModel.create({ data }));
}));

adminRouter.post('/products/:id/fitments', asyncHandler(async (req, res) => {
  const data = z.object({
    vehicleVariantIds: z.array(z.string().min(1)).min(1).max(500),
    notes: z.string().max(500).optional(),
    verified: z.boolean().default(false),
    source: z.enum(['MANUAL', 'SUPPLIER', 'OEM', 'COMMUNITY', 'IMPORTED']).default('MANUAL'),
  }).parse(req.body);
  await prisma.productFitment.createMany({
    data: data.vehicleVariantIds.map(vehicleVariantId => ({ productId: routeParam(req.params.id, 'id'), vehicleVariantId, notes: data.notes, verified: data.verified, source: data.source, verifiedAt: data.verified ? new Date() : null })),
    skipDuplicates: true,
  });
  res.status(201).json({ success: true, count: data.vehicleVariantIds.length });
}));

adminRouter.patch('/products/:id/fitments/:vehicleVariantId', asyncHandler(async (req, res) => {
  const body = z.object({
    verified: z.boolean().optional(),
    source: z.enum(['MANUAL', 'SUPPLIER', 'OEM', 'COMMUNITY', 'IMPORTED']).optional(),
    notes: z.string().max(500).nullable().optional(),
  }).parse(req.body);
  const productId = routeParam(req.params.id, 'id');
  const vehicleVariantId = routeParam(req.params.vehicleVariantId, 'vehicleVariantId');
  const updated = await prisma.productFitment.update({
    where: { productId_vehicleVariantId: { productId, vehicleVariantId } },
    data: {
      ...body,
      ...(body.verified === undefined ? {} : { verifiedAt: body.verified ? new Date() : null }),
    },
  });
  res.json(updated);
}));

adminRouter.delete('/products/:id/fitments/:vehicleVariantId', asyncHandler(async (req, res) => {
  await prisma.productFitment.deleteMany({ where: { productId: routeParam(req.params.id, 'id'), vehicleVariantId: routeParam(req.params.vehicleVariantId, 'vehicleVariantId') } });
  res.status(204).send();
}));

adminRouter.post('/suppliers', asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2),
    code: z.string().trim().min(2).max(50).transform(v => v.toLowerCase()),
    type: z.enum(['MOCK', 'CJ', 'SYNCEE', 'CUSTOM']).default('CUSTOM'),
    priority: z.number().int().min(1).default(100),
    baseUrl: z.string().url().optional(),
  }).parse(req.body);
  res.status(201).json(await prisma.supplier.create({ data }));
}));

adminRouter.patch('/suppliers/:id', asyncHandler(async (req, res) => {
  const data = z.object({
    name: z.string().min(2).optional(),
    active: z.boolean().optional(),
    priority: z.number().int().min(1).optional(),
    baseUrl: z.string().url().nullable().optional(),
  }).parse(req.body);
  res.json(await prisma.supplier.update({ where: { id: routeParam(req.params.id, 'id') }, data }));
}));

adminRouter.get('/supplier-products', asyncHandler(async (req, res) => {
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
  const items = await prisma.supplierProduct.findMany({
    where: supplierId ? { supplierId } : undefined,
    include: { supplier: true, product: { select: { id: true, name: true, sku: true, priceCents: true, currency: true } } },
    orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    take: 300,
  });
  res.json(items);
}));

adminRouter.post('/supplier-products', asyncHandler(async (req, res) => {
  const data = z.object({
    supplierId: z.string().min(1),
    productId: z.string().min(1),
    supplierProductId: z.string().min(1),
    supplierSku: z.string().optional(),
    costCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative().default(0),
    currency: z.string().length(3).default('USD'),
    stock: z.number().int().nonnegative().nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(365).optional(),
    warehouseCountry: z.string().trim().min(2).max(2).transform(v => v.toUpperCase()).optional(),
    reliabilityScore: z.number().min(0).max(100).optional(),
  }).parse(req.body);
  res.status(201).json(await prisma.supplierProduct.create({
    data: { ...data, availableStock: data.stock ?? null },
  }));
}));

adminRouter.patch('/supplier-products/:id', asyncHandler(async (req, res) => {
  const data = z.object({
    costCents: z.number().int().nonnegative().optional(),
    shippingCents: z.number().int().nonnegative().optional(),
    stock: z.number().int().nonnegative().nullable().optional(),
    active: z.boolean().optional(),
    leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
    warehouseCountry: z.string().trim().min(2).max(2).transform(v => v.toUpperCase()).nullable().optional(),
    reliabilityScore: z.number().min(0).max(100).nullable().optional(),
  }).parse(req.body);
  const id = routeParam(req.params.id, 'id');
  const { stock, ...metadata } = data;
  const updated = await prisma.$transaction(async tx => {
    if (Object.keys(metadata).length) await tx.supplierProduct.update({ where: { id }, data: metadata });
    if (stock !== undefined) await setSupplierReportedStock(tx, id, stock);
    return tx.supplierProduct.findUnique({ where: { id } });
  });
  if (!updated) throw new HttpError(404, 'Supplier product not found');
  res.json(updated);
}));

adminRouter.get('/fulfillments', asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const items = await prisma.fulfillment.findMany({
    where: status ? { status: status as any } : undefined,
    include: { supplier: true, order: { select: { id: true, orderNumber: true, email: true, totalCents: true, currency: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(items);
}));

adminRouter.post('/vehicles/variants', asyncHandler(async (req, res) => {
  const data = z.object({
    modelId: z.string().min(1),
    yearStart: z.number().int().min(1900),
    yearEnd: z.number().int().max(2200),
    trim: z.string().optional(),
    chassisCode: z.string().optional(),
    engineCode: z.string().min(1),
    engineName: z.string().min(1),
    displacementCc: z.number().int().positive().optional(),
    aspiration: z.string().optional(),
    fuelType: z.string().optional(),
    transmission: z.string().optional(),
    drivetrain: z.string().optional(),
  }).refine(v => v.yearEnd >= v.yearStart, { message: 'yearEnd must be >= yearStart' }).parse(req.body);
  res.status(201).json(await prisma.vehicleVariant.create({ data }));
}));

adminRouter.post('/payouts/:orderId/retry', asyncHandler(async (req, res) => {
  const orderId = routeParam(req.params.orderId, 'orderId');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new HttpError(404, 'Order not found');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) throw new HttpError(409, 'Only paid orders can have marketplace payouts');
  const payouts = await processReadyStripeMarketplacePayouts(orderId);
  res.json(payouts);
}));
