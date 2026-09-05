import { Router } from 'express';
import { z } from 'zod';
import { prisma, readPrisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { scoreAccountRisk } from '../../services/risk-score.service';
import { audit } from '../../services/audit.service';

export const customerIntelligenceRouter = Router();
customerIntelligenceRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

const paidPaymentStatuses = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const successfulOrderStatuses = ['PAID', 'PROCESSING', 'SUBMITTED_TO_SUPPLIER', 'PARTIALLY_FULFILLED', 'FULFILLED'] as const;
const tagSchema = z.string().trim().min(2).max(40)
  .regex(/^[A-Za-z0-9 _-]+$/)
  .transform(value => value.toUpperCase().replace(/\s+/g, '_'));

function paidOrders<T extends { paymentStatus: string }>(orders: T[]) {
  return orders.filter(order => paidPaymentStatuses.includes(order.paymentStatus as any));
}

function grossPaidSpend(orders: Array<{ totalCents: number; paymentStatus: string }>) {
  return paidOrders(orders).reduce((sum, order) => sum + order.totalCents, 0);
}

function successfulRefunds(orders: Array<{ refunds?: Array<{ amountCents: number; status?: string }> }>) {
  return orders.reduce((sum, order) => sum + (order.refunds || [])
    .filter(refund => !refund.status || refund.status === 'SUCCEEDED')
    .reduce((inner, refund) => inner + refund.amountCents, 0), 0);
}

function segments(input: {
  createdAt: Date;
  isActive: boolean;
  paidOrderCount: number;
  netLifetimeValueCents: number;
  grossPaidSpendCents: number;
  refundCents: number;
  dealer: boolean;
  lastActivityAt?: Date | null;
}) {
  const result: string[] = [];
  const now = Date.now();
  if (!input.isActive) result.push('INACTIVE_ACCOUNT');
  if (now - input.createdAt.getTime() < 30 * 86_400_000) result.push('NEW_CUSTOMER');
  if (input.paidOrderCount > 1) result.push('RETURNING_CUSTOMER');
  if (input.netLifetimeValueCents >= 500_000) result.push('HIGH_VALUE');
  if (input.netLifetimeValueCents >= 2_000_000) result.push('VIP');
  if (input.dealer) result.push('DEALER');
  if (input.grossPaidSpendCents > 0 && input.refundCents / input.grossPaidSpendCents >= 0.35) result.push('HIGH_REFUND_RATE');
  if (input.lastActivityAt && now - input.lastActivityAt.getTime() > 90 * 86_400_000) result.push('AT_RISK');
  return result;
}

function maskedVin(vin?: string | null) {
  const value = String(vin || '').trim();
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function latestActivity(user: { updatedAt: Date; sessions: Array<{ lastUsedAt: Date }>; orders: Array<{ createdAt: Date }> }) {
  const values = [user.updatedAt, user.sessions[0]?.lastUsedAt, user.orders[0]?.createdAt].filter(Boolean) as Date[];
  return values.sort((a, b) => b.getTime() - a.getTime())[0] ?? user.updatedAt;
}

customerIntelligenceRouter.get('/summary', asyncHandler(async (_req, res) => {
  const [customers, garageGroups] = await Promise.all([
    readPrisma.user.findMany({
      where: { role: 'CUSTOMER' },
      select: {
        id: true, isActive: true,
        orders: {
          where: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
          select: { totalCents: true, paymentStatus: true, refunds: { where: { status: 'SUCCEEDED' }, select: { amountCents: true, status: true } } },
        },
      },
    }),
    readPrisma.garageVehicle.groupBy({
      by: ['vehicleVariantId'],
      _count: { _all: true },
      orderBy: { _count: { vehicleVariantId: 'desc' } },
      take: 8,
    }),
  ]);

  let grossRevenueCents = 0;
  let refundsCents = 0;
  let paidOrderCount = 0;
  let customersWithOrders = 0;
  let repeatCustomers = 0;
  for (const customer of customers) {
    const gross = grossPaidSpend(customer.orders);
    const refunds = successfulRefunds(customer.orders);
    grossRevenueCents += gross;
    refundsCents += refunds;
    paidOrderCount += customer.orders.length;
    if (customer.orders.length) customersWithOrders += 1;
    if (customer.orders.length > 1) repeatCustomers += 1;
  }
  const netRevenueCents = Math.max(0, grossRevenueCents - refundsCents);

  const variants = garageGroups.length ? await readPrisma.vehicleVariant.findMany({
    where: { id: { in: garageGroups.map(row => row.vehicleVariantId) } },
    select: { id: true, engineCode: true, model: { select: { name: true, make: { select: { name: true } } } } },
  }) : [];
  const variantMap = new Map(variants.map(row => [row.id, row]));

  res.json({
    customerCount: customers.length,
    activeCount: customers.filter(customer => customer.isActive).length,
    inactiveCount: customers.filter(customer => !customer.isActive).length,
    customersWithOrders,
    repeatCustomers,
    repeatPurchaseRate: customersWithOrders ? repeatCustomers / customersWithOrders : 0,
    paidOrderCount,
    grossRevenueCents,
    refundsCents,
    netRevenueCents,
    avgCustomerValueCents: customersWithOrders ? Math.round(netRevenueCents / customersWithOrders) : 0,
    topVehicles: garageGroups.map(row => {
      const variant = variantMap.get(row.vehicleVariantId);
      return {
        vehicleVariantId: row.vehicleVariantId,
        count: row._count._all,
        label: variant ? `${variant.model.make.name} ${variant.model.name} · ${variant.engineCode}` : row.vehicleVariantId,
      };
    }),
  });
}));

customerIntelligenceRouter.get('/customers', asyncHandler(async (req, res) => {
  const query = z.object({
    q: z.string().trim().max(120).optional(),
    tag: z.string().trim().max(40).optional(),
    status: z.enum(['ALL', 'ACTIVE', 'INACTIVE', 'VERIFIED', 'DEALER', 'HIGH_VALUE', 'VIP', 'AT_RISK']).default('ALL'),
    sort: z.enum(['newest', 'oldest', 'spend_desc', 'orders_desc', 'activity_desc']).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(req.query);

  const where: any = {
    role: 'CUSTOMER',
    ...(query.q ? { OR: [
      { email: { contains: query.q, mode: 'insensitive' } },
      { firstName: { contains: query.q, mode: 'insensitive' } },
      { lastName: { contains: query.q, mode: 'insensitive' } },
      { username: { contains: query.q, mode: 'insensitive' } },
      { phone: { contains: query.q, mode: 'insensitive' } },
      { orders: { some: { orderNumber: { contains: query.q, mode: 'insensitive' } } } },
    ] } : {}),
    ...(query.tag ? { customerTags: { some: { tag: query.tag.toUpperCase() } } } : {}),
    ...(query.status === 'ACTIVE' ? { isActive: true } : {}),
    ...(query.status === 'INACTIVE' ? { isActive: false } : {}),
    ...(query.status === 'VERIFIED' ? { emailVerifiedAt: { not: null } } : {}),
    ...(query.status === 'DEALER' ? { sellerProfile: { dealerVerifiedAt: { not: null } } } : {}),
  };

  // Load the complete matching customer metric set first, then segment/sort,
  // and only then paginate. This keeps HIGH_VALUE/VIP/AT_RISK and spend/order
  // sorting correct across pages instead of sorting only one page.
  const users = await readPrisma.user.findMany({
    where,
    select: {
      id: true, email: true, firstName: true, lastName: true, username: true, phone: true, country: true,
      isActive: true, createdAt: true, updatedAt: true, emailVerifiedAt: true, phoneVerifiedAt: true, twoFactorEnabled: true,
      sellerProfile: { select: { storeName: true, verified: true, dealerVerifiedAt: true, totalSales: true, ratingAverage: true } },
      customerTags: { select: { tag: true }, orderBy: { createdAt: 'asc' } },
      orders: {
        select: {
          id: true, totalCents: true, paymentStatus: true, createdAt: true,
          refunds: { where: { status: 'SUCCEEDED' }, select: { amountCents: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      sessions: { where: { revokedAt: null }, select: { lastUsedAt: true }, orderBy: { lastUsedAt: 'desc' }, take: 1 },
      _count: { select: { orders: true, garage: true, wishlistItems: true, productReviews: true, supportCases: true, marketplaceProducts: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  let items = users.map(user => {
    const grossPaidSpendCents = grossPaidSpend(user.orders);
    const refundCents = successfulRefunds(user.orders);
    const netLifetimeValueCents = Math.max(0, grossPaidSpendCents - refundCents);
    const paid = paidOrders(user.orders);
    const paidOrderCount = paid.length;
    const lastPurchaseAt = paid[0]?.createdAt ?? null;
    const lastActivityAt = latestActivity(user);
    const customerSegments = segments({
      createdAt: user.createdAt,
      isActive: user.isActive,
      paidOrderCount,
      netLifetimeValueCents,
      grossPaidSpendCents,
      refundCents,
      dealer: Boolean(user.sellerProfile?.dealerVerifiedAt),
      lastActivityAt,
    });
    return {
      id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, username: user.username,
      phone: user.phone, country: user.country, isActive: user.isActive, createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt, phoneVerifiedAt: user.phoneVerifiedAt, twoFactorEnabled: user.twoFactorEnabled,
      sellerProfile: user.sellerProfile, _count: user._count,
      grossPaidSpendCents, refundCents, netLifetimeValueCents, paidOrderCount,
      averageOrderValueCents: paidOrderCount ? Math.round(netLifetimeValueCents / paidOrderCount) : 0,
      lastPurchaseAt, lastActivityAt,
      segments: customerSegments,
      tags: user.customerTags.map(tag => tag.tag),
    };
  });

  if (query.status === 'HIGH_VALUE') items = items.filter(item => item.segments.includes('HIGH_VALUE'));
  if (query.status === 'VIP') items = items.filter(item => item.segments.includes('VIP'));
  if (query.status === 'AT_RISK') items = items.filter(item => item.segments.includes('AT_RISK'));

  items.sort((a, b) => {
    if (query.sort === 'oldest') return a.createdAt.getTime() - b.createdAt.getTime();
    if (query.sort === 'spend_desc') return b.netLifetimeValueCents - a.netLifetimeValueCents || b.createdAt.getTime() - a.createdAt.getTime();
    if (query.sort === 'orders_desc') return b.paidOrderCount - a.paidOrderCount || b.netLifetimeValueCents - a.netLifetimeValueCents;
    if (query.sort === 'activity_desc') return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const total = items.length;
  const start = (query.page - 1) * query.limit;
  res.json({ items: items.slice(start, start + query.limit), total, page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)) });
}));

customerIntelligenceRouter.get('/customers/:id', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const isAdmin = req.auth!.role === 'ADMIN';
  const user = await readPrisma.user.findFirst({
    where: { id, role: 'CUSTOMER' },
    select: {
      id: true, email: true, firstName: true, lastName: true, username: true, displayName: true, phone: true, country: true,
      avatarUrl: true, isActive: true, createdAt: true, updatedAt: true, emailVerifiedAt: true, phoneVerifiedAt: true,
      twoFactorEnabled: true, twoFactorEnabledAt: true, profileVisibility: true, garageVisibility: true, messagePrivacy: true,
      sellerProfile: {
        select: { storeName: true, bio: true, location: true, verified: true, dealerVerifiedAt: true, responseTimeHours: true, totalSales: true, ratingAverage: true, ratingCount: true, createdAt: true },
      },
      dealerVerification: { select: { businessName: true, country: true, status: true, submittedAt: true, reviewedAt: true } },
      orders: {
        orderBy: { createdAt: 'desc' }, take: 100,
        select: {
          id: true, orderNumber: true, status: true, paymentStatus: true, currency: true,
          subtotalCents: true, shippingCents: true, taxCents: true, dutyCents: true, discountCents: true, totalCents: true,
          paymentProvider: true, createdAt: true, updatedAt: true,
          refunds: { where: { status: 'SUCCEEDED' }, select: { amountCents: true, status: true, createdAt: true } },
          items: { select: { id: true, name: true, sku: true, quantity: true, totalPriceCents: true, sourceType: true, sellerId: true, fitmentSnapshot: true } },
          fulfillments: { select: { status: true, carrier: true, trackingNumber: true, shippedAt: true, deliveredAt: true } },
        },
      },
      garage: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true, nickname: true, year: true, vin: true, isPrimary: true, createdAt: true,
          vehicleVariant: { select: { engineCode: true, engineName: true, chassisCode: true, model: { select: { name: true, make: { select: { name: true } } } } } },
        },
      },
      wishlistItems: {
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { createdAt: true, product: { select: { id: true, name: true, sku: true, priceCents: true, currency: true } } },
      },
      productReviews: {
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, rating: true, title: true, verifiedPurchase: true, status: true, createdAt: true, product: { select: { name: true, sku: true } } },
      },
      supportCases: {
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, type: true, status: true, reason: true, createdAt: true, updatedAt: true, order: { select: { orderNumber: true } } },
      },
      marketplaceProducts: {
        orderBy: { createdAt: 'desc' }, take: 40,
        select: { id: true, name: true, sku: true, status: true, stockQuantity: true, priceCents: true, currency: true, purchaseCount: true, createdAt: true },
      },
      sessions: {
        orderBy: { lastUsedAt: 'desc' }, take: 20,
        select: { id: true, expiresAt: true, revokedAt: true, lastUsedAt: true, userAgent: true, ipAddress: true, createdAt: true },
      },
      securityEvents: {
        orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, type: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true },
      },
      customerNotes: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, body: true, createdAt: true, author: { select: { id: true, email: true, firstName: true, lastName: true } } },
      },
      customerTags: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, tag: true, createdAt: true, assignedBy: { select: { id: true, email: true, firstName: true, lastName: true } } },
      },
      _count: { select: { orders: true, garage: true, wishlistItems: true, productReviews: true, supportCases: true, marketplaceProducts: true, followers: true, following: true } },
    },
  });
  if (!user) throw new HttpError(404, 'Customer not found');

  const since = new Date(Date.now() - 7 * 86_400_000);
  const [failedLogins7d, newDeviceLogins7d, impersonationSignals7d, openReports] = await Promise.all([
    readPrisma.securityEvent.count({ where: { userId: id, createdAt: { gte: since }, type: { in: ['LOGIN_FAILED', 'SIGN_IN_FAILED', 'AUTH_FAILED'] } } }),
    readPrisma.securityEvent.count({ where: { userId: id, createdAt: { gte: since }, type: { in: ['NEW_DEVICE_LOGIN', 'NEW_DEVICE'] } } }),
    readPrisma.securityEvent.count({ where: { userId: id, createdAt: { gte: since }, type: { contains: 'IMPERSONATION', mode: 'insensitive' } } }),
    readPrisma.contentReport.count({ where: { targetType: 'USER', targetId: id, status: { in: ['OPEN', 'REVIEWING'] } } }),
  ]);
  const risk = scoreAccountRisk({
    createdAt: user.createdAt, emailVerified: Boolean(user.emailVerifiedAt), phoneVerified: Boolean(user.phoneVerifiedAt),
    twoFactorEnabled: user.twoFactorEnabled, failedLogins7d, newDeviceLogins7d, openReports, impersonationSignals7d,
  });

  const grossPaidSpendCents = grossPaidSpend(user.orders);
  const refundCents = successfulRefunds(user.orders);
  const netLifetimeValueCents = Math.max(0, grossPaidSpendCents - refundCents);
  const paid = paidOrders(user.orders);
  const paidOrderCount = paid.length;
  const successfulOrders = user.orders.filter(order => successfulOrderStatuses.includes(order.status as any)).length;
  const cancelledOrders = user.orders.filter(order => order.status === 'CANCELLED').length;
  const lastPurchaseAt = paid[0]?.createdAt ?? null;
  const lastActivityAt = latestActivity(user);
  const customerSegments = segments({
    createdAt: user.createdAt, isActive: user.isActive, paidOrderCount, netLifetimeValueCents,
    grossPaidSpendCents, refundCents, dealer: Boolean(user.sellerProfile?.dealerVerifiedAt), lastActivityAt,
  });

  const timeline: Array<{ type: string; label: string; at: Date }> = [
    { type: 'ACCOUNT', label: 'Account created', at: user.createdAt },
  ];
  if (user.emailVerifiedAt) timeline.push({ type: 'SECURITY', label: 'Email verified', at: user.emailVerifiedAt });
  if (user.phoneVerifiedAt) timeline.push({ type: 'SECURITY', label: 'Phone verified', at: user.phoneVerifiedAt });
  if (user.twoFactorEnabledAt) timeline.push({ type: 'SECURITY', label: 'Authenticator 2FA enabled', at: user.twoFactorEnabledAt });
  for (const vehicle of user.garage) timeline.push({ type: 'GARAGE', label: `Added ${vehicle.year} ${vehicle.vehicleVariant.model.make.name} ${vehicle.vehicleVariant.model.name} · ${vehicle.vehicleVariant.engineCode}`, at: vehicle.createdAt });
  for (const order of user.orders) timeline.push({ type: 'ORDER', label: `Order ${order.orderNumber} · ${order.status.replaceAll('_', ' ')}`, at: order.createdAt });
  for (const review of user.productReviews) timeline.push({ type: 'REVIEW', label: `${review.rating}-star review · ${review.product.name}`, at: review.createdAt });
  for (const support of user.supportCases) timeline.push({ type: 'SUPPORT', label: `${support.type.replaceAll('_', ' ')} case · ${support.status.replaceAll('_', ' ')}`, at: support.createdAt });
  if (isAdmin) for (const event of user.securityEvents.slice(0, 25)) timeline.push({ type: 'SECURITY', label: event.type.replaceAll('_', ' '), at: event.createdAt });
  for (const note of user.customerNotes) timeline.push({ type: 'STAFF_NOTE', label: 'Internal staff note added', at: note.createdAt });
  timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

  res.json({
    customer: {
      id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, username: user.username,
      displayName: user.displayName, phone: user.phone, country: user.country, avatarUrl: user.avatarUrl,
      isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt,
      emailVerified: Boolean(user.emailVerifiedAt), phoneVerified: Boolean(user.phoneVerifiedAt),
      twoFactorEnabled: user.twoFactorEnabled, profileVisibility: user.profileVisibility,
      garageVisibility: user.garageVisibility, messagePrivacy: user.messagePrivacy,
    },
    metrics: {
      grossPaidSpendCents, refundCents, netLifetimeValueCents, paidOrderCount, successfulOrders, cancelledOrders,
      averageOrderValueCents: paidOrderCount ? Math.round(netLifetimeValueCents / paidOrderCount) : 0,
      lastPurchaseAt, lastActivityAt,
      daysSinceLastPurchase: lastPurchaseAt ? Math.floor((Date.now() - lastPurchaseAt.getTime()) / 86_400_000) : null,
      wishlistItems: user._count.wishlistItems, garageVehicles: user._count.garage, reviews: user._count.productReviews,
      supportCases: user._count.supportCases, listings: user._count.marketplaceProducts,
      followers: user._count.followers, following: user._count.following,
    },
    segments: customerSegments,
    risk,
    seller: user.sellerProfile ? { ...user.sellerProfile, dealerVerification: user.dealerVerification } : null,
    orders: user.orders,
    garage: user.garage.map(vehicle => ({ ...vehicle, vin: undefined, maskedVin: maskedVin(vehicle.vin) })),
    wishlist: user.wishlistItems,
    reviews: user.productReviews,
    supportCases: user.supportCases,
    listings: user.marketplaceProducts,
    security: isAdmin ? { sessions: user.sessions, events: user.securityEvents } : {
      sessions: [],
      events: [],
      restricted: true,
      summary: { failedLogins7d, newDeviceLogins7d, openReports, impersonationSignals7d },
    },
    notes: user.customerNotes,
    tags: user.customerTags,
    timeline: timeline.slice(0, 150),
  });
}));

customerIntelligenceRouter.post('/customers/:id/notes', asyncHandler(async (req, res) => {
  const customerId = routeParam(req.params.id, 'id');
  const { body } = z.object({ body: z.string().trim().min(2).max(4000) }).parse(req.body);
  if (!await prisma.user.count({ where: { id: customerId, role: 'CUSTOMER' } })) throw new HttpError(404, 'Customer not found');
  const note = await prisma.customerNote.create({
    data: { customerId, authorUserId: req.auth!.userId, body },
    include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
  });
  await audit({ actorUserId: req.auth!.userId, action: 'CUSTOMER_NOTE_CREATED', targetType: 'USER', targetId: customerId, metadata: { noteId: note.id } });
  res.status(201).json(note);
}));

customerIntelligenceRouter.delete('/customers/:id/notes/:noteId', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const customerId = routeParam(req.params.id, 'id');
  const noteId = routeParam(req.params.noteId, 'noteId');
  const deleted = await prisma.customerNote.deleteMany({ where: { id: noteId, customerId } });
  if (!deleted.count) throw new HttpError(404, 'Customer note not found');
  await audit({ actorUserId: req.auth!.userId, action: 'CUSTOMER_NOTE_DELETED', targetType: 'USER', targetId: customerId, metadata: { noteId } });
  res.status(204).send();
}));

customerIntelligenceRouter.post('/customers/:id/tags', asyncHandler(async (req, res) => {
  const customerId = routeParam(req.params.id, 'id');
  const { tag } = z.object({ tag: tagSchema }).parse(req.body);
  if (!await prisma.user.count({ where: { id: customerId, role: 'CUSTOMER' } })) throw new HttpError(404, 'Customer not found');
  const record = await prisma.customerTagAssignment.upsert({
    where: { customerId_tag: { customerId, tag } },
    update: { assignedByUserId: req.auth!.userId },
    create: { customerId, tag, assignedByUserId: req.auth!.userId },
  });
  await audit({ actorUserId: req.auth!.userId, action: 'CUSTOMER_TAG_ASSIGNED', targetType: 'USER', targetId: customerId, metadata: { tag } });
  res.status(201).json(record);
}));

customerIntelligenceRouter.delete('/customers/:id/tags/:tag', asyncHandler(async (req, res) => {
  const customerId = routeParam(req.params.id, 'id');
  const tag = decodeURIComponent(routeParam(req.params.tag, 'tag')).toUpperCase();
  await prisma.customerTagAssignment.deleteMany({ where: { customerId, tag } });
  await audit({ actorUserId: req.auth!.userId, action: 'CUSTOMER_TAG_REMOVED', targetType: 'USER', targetId: customerId, metadata: { tag } });
  res.status(204).send();
}));

customerIntelligenceRouter.patch('/customers/:id/status', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const customerId = routeParam(req.params.id, 'id');
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  const existing = await prisma.user.findFirst({ where: { id: customerId, role: 'CUSTOMER' }, select: { id: true, email: true, isActive: true } });
  if (!existing) throw new HttpError(404, 'Customer not found');
  const customer = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({ where: { id: customerId }, data: { isActive }, select: { id: true, email: true, isActive: true } });
    if (!isActive) await tx.authSession.updateMany({ where: { userId: customerId, revokedAt: null }, data: { revokedAt: new Date() } });
    return updated;
  });
  await audit({
    actorUserId: req.auth!.userId,
    action: isActive ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_DEACTIVATED',
    targetType: 'USER',
    targetId: customerId,
  });
  res.json(customer);
}));
