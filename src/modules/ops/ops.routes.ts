import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { recommendedRetailPrice } from '../../services/pricing.service';
import { processProductAlerts } from '../../services/product-alert.service';
import { setSupplierReportedStock } from '../../services/supplier-inventory.service';

export const opsRouter = Router();
opsRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

opsRouter.get('/finance', asyncHandler(async (_req, res) => {
  const [paidOrders, refunds, paidPayouts, payoutGroups, totalOrders] = await Promise.all([
    prisma.order.findMany({ where: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, include: { items: true } }),
    prisma.refundRecord.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountCents: true }, _count: true }),
    prisma.sellerPayout.aggregate({ where: { status: 'PAID' }, _sum: { amountCents: true, platformFeeCents: true }, _count: true }),
    prisma.sellerPayout.groupBy({ by: ['status'], _sum: { amountCents: true }, _count: true }),
    prisma.order.count(),
  ]);
  const gmvCents = paidOrders.reduce((sum, order) => sum + order.totalCents, 0);
  const supplierCostCents = paidOrders.reduce((sum, order) => sum + order.items.reduce((n, item) => n + (item.supplierCostCents ?? 0), 0), 0);
  const marketplaceFeesCents = paidOrders.reduce((sum, order) => sum + order.items.reduce((n, item) => n + item.platformFeeCents, 0), 0);
  const refundsCents = refunds._sum.amountCents ?? 0;
  const sellerPayoutsCents = paidPayouts._sum.amountCents ?? 0;
  const payoutByStatus = Object.fromEntries(payoutGroups.map(group => [group.status, group._sum.amountCents ?? 0]));
  const netRevenueBeforeProcessorFeesCents = gmvCents - supplierCostCents - sellerPayoutsCents - refundsCents;
  res.json({
    gmvCents,
    supplierCostCents,
    marketplaceFeesCents,
    sellerPayoutsCents,
    pendingSellerPayoutsCents: payoutByStatus.PENDING ?? 0,
    readySellerPayoutsCents: payoutByStatus.READY ?? 0,
    processingSellerPayoutsCents: payoutByStatus.PROCESSING ?? 0,
    blockedSellerPayoutsCents: payoutByStatus.BLOCKED ?? 0,
    failedSellerPayoutsCents: payoutByStatus.FAILED ?? 0,
    refundsCents,
    netRevenueBeforeProcessorFeesCents,
    averageOrderValueCents: paidOrders.length ? Math.round(gmvCents / paidOrders.length) : 0,
    paidOrders: paidOrders.length,
    totalOrders,
    refundCount: refunds._count,
    paidPayoutCount: paidPayouts._count,
  });
}));

opsRouter.get('/analytics', asyncHandler(async (_req, res) => {
  const [topProducts, searches, wishlists, reviews, cases] = await Promise.all([
    prisma.product.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, sku: true, viewCount: true, purchaseCount: true, wishlistCount: true }, orderBy: { viewCount: 'desc' }, take: 20 }),
    prisma.searchEvent.groupBy({ by: ['query'], _count: { query: true }, _sum: { resultsCount: true }, orderBy: { _count: { query: 'desc' } }, take: 20 }),
    prisma.wishlistItem.count(),
    prisma.productReview.count({ where: { status: 'PUBLISHED' } }),
    prisma.supportCase.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER'] } } }),
  ]);
  res.json({ topProducts, searches, wishlists, reviews, openCases: cases });
}));

opsRouter.get('/fraud-flags', asyncHandler(async (_req, res) => {
  const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: recent } },
    include: { items: true, events: true, user: { select: { id: true, createdAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const flags = orders.flatMap(order => {
    const reasons: string[] = [];
    if (order.totalCents >= 200_000) reasons.push('HIGH_VALUE_ORDER');
    if (order.paymentStatus === 'FAILED') reasons.push('FAILED_PAYMENT');
    if (order.user && order.createdAt.getTime() - order.user.createdAt.getTime() < 60 * 60 * 1000 && order.totalCents >= 75_000) reasons.push('NEW_ACCOUNT_HIGH_VALUE');
    if (order.events.filter(e => e.type.includes('PAYMENT')).length >= 4) reasons.push('REPEATED_PAYMENT_EVENTS');
    return reasons.length ? [{ orderId: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents, email: order.email, reasons }] : [];
  });
  res.json(flags);
}));

opsRouter.get('/promos', asyncHandler(async (_req, res) => {
  res.json(await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } }));
}));

opsRouter.post('/promos', asyncHandler(async (req, res) => {
  const body = z.object({
    code: z.string().trim().min(3).max(50).transform(v => v.toUpperCase()),
    percentOff: z.number().int().min(1).max(100).optional(),
    amountOffCents: z.number().int().positive().optional(),
    minimumCents: z.number().int().nonnegative().default(0),
    maxUses: z.number().int().positive().optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    active: z.boolean().default(true),
  }).refine(v => Boolean(v.percentOff) !== Boolean(v.amountOffCents), { message: 'Choose percentOff or amountOffCents' }).parse(req.body);
  res.status(201).json(await prisma.promoCode.create({ data: body }));
}));

opsRouter.patch('/promos/:id', asyncHandler(async (req, res) => {
  const body = z.object({ active: z.boolean().optional(), maxUses: z.number().int().positive().nullable().optional(), endsAt: z.coerce.date().nullable().optional() }).parse(req.body);
  res.json(await prisma.promoCode.update({ where: { id: routeParam(req.params.id, 'id') }, data: body }));
}));

opsRouter.get('/pricing-rules', asyncHandler(async (_req, res) => {
  res.json(await prisma.pricingRule.findMany({ include: { supplier: true, category: true }, orderBy: { priority: 'asc' } }));
}));

opsRouter.post('/pricing-rules', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(100),
    supplierId: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    markupPercent: z.number().min(0).max(1000).nullable().optional(),
    fixedMarkupCents: z.number().int().min(0).nullable().optional(),
    minimumProfitCents: z.number().int().min(0).nullable().optional(),
    priority: z.number().int().min(1).max(1000).default(100),
    active: z.boolean().default(true),
  }).parse(req.body);
  res.status(201).json(await prisma.pricingRule.create({ data: body }));
}));

opsRouter.post('/pricing/preview', asyncHandler(async (req, res) => {
  const body = z.object({ supplierId: z.string().optional(), categoryId: z.string().optional(), costCents: z.number().int().nonnegative(), shippingCents: z.number().int().nonnegative().default(0) }).parse(req.body);
  res.json({ recommendedPriceCents: await recommendedRetailPrice(body) });
}));

opsRouter.post('/pricing/apply', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
  const links = await prisma.supplierProduct.findMany({ where: { active: true }, include: { product: true }, orderBy: { costCents: 'asc' } });
  const seen = new Set<string>();
  let updated = 0;
  for (const link of links) {
    if (seen.has(link.productId) || link.product.sourceType !== 'DROPSHIP') continue;
    seen.add(link.productId);
    const priceCents = await recommendedRetailPrice({ supplierId: link.supplierId, categoryId: link.product.categoryId, costCents: link.costCents, shippingCents: link.shippingCents });
    if (priceCents > 0 && priceCents !== link.product.priceCents) {
      const previousPriceCents = link.product.priceCents;
      await prisma.product.update({ where: { id: link.productId }, data: { priceCents } });
      await processProductAlerts({ productId: link.productId, previousPriceCents, newPriceCents: priceCents }).catch(() => undefined);
      updated += 1;
    }
  }
  res.json({ updated });
}));

opsRouter.get('/suppliers', asyncHandler(async (_req, res) => {
  const rows = await prisma.supplier.findMany({
    include: {
      _count: { select: { products: true, fulfillments: true, syncRuns: true } },
      syncRuns: { orderBy: { startedAt: 'desc' }, take: 1 },
    },
    orderBy: [{ active: 'desc' }, { priority: 'asc' }],
  });
  res.json(rows);
}));

opsRouter.post('/suppliers/:id/import', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const supplierId = routeParam(req.params.id, 'id');
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new HttpError(404, 'Supplier not found');
  const body = z.object({ items: z.array(z.object({
    productSku: z.string().min(1),
    supplierProductId: z.string().min(1),
    supplierSku: z.string().optional(),
    costCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative().default(0),
    stock: z.number().int().nonnegative().nullable().optional(),
    currency: z.string().length(3).default('USD'),
    leadTimeDays: z.number().int().min(0).max(365).optional(),
    warehouseCountry: z.string().trim().min(2).max(2).transform(v => v.toUpperCase()).optional(),
    reliabilityScore: z.number().min(0).max(100).optional(),
  })).min(1).max(5000) }).parse(req.body);

  const run = await prisma.supplierSyncRun.create({ data: { supplierId, status: 'RUNNING', productsSeen: body.items.length } });
  let productsUpdated = 0;
  let stockUpdates = 0;
  try {
    for (const row of body.items) {
      const product = await prisma.product.findUnique({ where: { sku: row.productSku } });
      if (!product) continue;
      const previous = await prisma.supplierProduct.findUnique({ where: { supplierId_supplierProductId: { supplierId, supplierProductId: row.supplierProductId } } });
      const previousAvailableStock = previous?.availableStock ?? null;
      const newAvailableStock = await prisma.$transaction(async tx => {
        const link = await tx.supplierProduct.upsert({
          where: { supplierId_supplierProductId: { supplierId, supplierProductId: row.supplierProductId } },
          update: { supplierSku: row.supplierSku, costCents: row.costCents, shippingCents: row.shippingCents, currency: row.currency.toUpperCase(), active: true, leadTimeDays: row.leadTimeDays, warehouseCountry: row.warehouseCountry, reliabilityScore: row.reliabilityScore, lastSyncedAt: new Date() },
          create: { supplierId, productId: product.id, supplierProductId: row.supplierProductId, supplierSku: row.supplierSku, costCents: row.costCents, shippingCents: row.shippingCents, stock: row.stock ?? null, availableStock: row.stock ?? null, currency: row.currency.toUpperCase(), active: true, leadTimeDays: row.leadTimeDays, warehouseCountry: row.warehouseCountry, reliabilityScore: row.reliabilityScore, lastSyncedAt: new Date() },
        });
        return setSupplierReportedStock(tx, link.id, row.stock ?? null);
      });
      productsUpdated += 1;
      if (previousAvailableStock !== newAvailableStock) {
        stockUpdates += 1;
        await processProductAlerts({ productId: product.id, previousStock: previousAvailableStock, newStock: newAvailableStock }).catch(() => undefined);
      }
    }
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', productsUpdated, stockUpdates, finishedAt: new Date() } });
    res.json({ runId: run.id, productsSeen: body.items.length, productsUpdated, stockUpdates });
  } catch (error) {
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown sync error', finishedAt: new Date() } });
    throw error;
  }
}));

opsRouter.patch('/sellers/:userId/verification', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const { verified } = z.object({ verified: z.boolean() }).parse(req.body);
  const userId = routeParam(req.params.userId, 'userId');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, 'Seller not found');
  const profile = await prisma.sellerProfile.upsert({ where: { userId }, update: { verified }, create: { userId, verified } });
  res.json(profile);
}));
