import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { env } from '../../config/env';
import {
  createMarketplaceRecipientAccount,
  createMarketplaceRecipientOnboardingLink,
  getStripe,
  StripeV2RequestError,
} from '../../services/stripe.service';
import { markMarketplacePayoutReady, processReadyStripeMarketplacePayouts } from '../../services/marketplace-payout.service';
import { recomputeOrderFulfillmentStatus } from '../../services/order-lifecycle.service';
import { createNotification } from '../../services/notification.service';
import { sendEmail } from '../../services/email.service';
import { publicProduct } from '../../lib/public-product';

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
  warrantyText: z.string().max(1000).optional(),
  returnDays: z.number().int().min(0).max(365).optional(),
  installDifficulty: z.string().max(80).optional(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  videoUrl: z.string().url().optional(),
  shippingMinDays: z.number().int().min(0).max(365).optional(),
  shippingMaxDays: z.number().int().min(0).max(365).optional(),
  requiresFitment: z.boolean().default(false),
  isUniversal: z.boolean().default(true),
  fitmentVehicleVariantIds: z.array(z.string().min(1)).max(100).default([]),
  images: z.array(z.object({
    url: z.string().url().refine(value => value.startsWith('https://'), 'Image URL must use HTTPS'),
    alt: z.string().max(240).optional(),
    position: z.number().int().min(0).max(20).default(0),
  })).max(8).default([]),
});

function assertFitmentMode(requiresFitment: boolean, isUniversal: boolean) {
  if (requiresFitment === isUniversal) {
    throw new HttpError(400, 'Choose either vehicle-specific fitment or Universal part');
  }
}

function assertPublishableFitment(requiresFitment: boolean, isUniversal: boolean, fitmentIds: string[]) {
  assertFitmentMode(requiresFitment, isUniversal);
  if (requiresFitment && fitmentIds.length === 0) {
    throw new HttpError(400, 'Add at least one compatible vehicle or mark the part universal');
  }
}

async function validatedFitmentIds(ids: string[]) {
  const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
  if (!unique.length) return unique;
  const variants = await prisma.vehicleVariant.findMany({
    where: { id: { in: unique } },
    select: { id: true },
  });
  if (variants.length !== unique.length) throw new HttpError(400, 'One or more selected vehicle fitments are invalid');
  return unique;
}

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
        seller: { select: { id: true, firstName: true, lastName: true, createdAt: true, sellerProfile: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.json({ items: items.map(publicProduct), total, page: query.page, pages: Math.max(1, Math.ceil(total / query.limit)) });
}));

marketplaceRouter.get('/seller-config', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({
    commissionPercent: env.MARKETPLACE_COMMISSION_PERCENT,
    commissionAcceptedAt: user.sellerCommissionAcceptedAt,
    stripeConnectConfigured: Boolean(env.STRIPE_SECRET_KEY),
    payoutAccountId: user.stripeConnectAccountId,
    payoutsEnabled: user.stripeConnectPayoutsEnabled,
    chargesEnabled: user.stripeConnectChargesEnabled,
    sellerCountry: user.sellerCountry,
  });
}));

marketplaceRouter.get('/payout/status', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  const stripe = getStripe();
  if (!stripe || !user.stripeConnectAccountId) {
    return res.json({ connected: false, payoutsEnabled: false, chargesEnabled: false, accountId: user.stripeConnectAccountId });
  }
  const account = await stripe.accounts.retrieve(user.stripeConnectAccountId);
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeConnectPayoutsEnabled: account.payouts_enabled, stripeConnectChargesEnabled: account.charges_enabled },
  });
  res.json({
    connected: true,
    accountId: account.id,
    payoutsEnabled: account.payouts_enabled,
    chargesEnabled: account.charges_enabled,
    detailsSubmitted: account.details_submitted,
    requirementsDue: account.requirements?.currently_due ?? [],
  });
}));

marketplaceRouter.post('/payout/onboard', requireAuth, asyncHandler(async (req, res) => {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Stripe Connect is not configured');
  const body = z.object({ country: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');

  let appUrl: URL;
  try { appUrl = new URL(env.APP_URL); }
  catch { throw new HttpError(500, 'APP_URL is invalid. Set it to the public HTTPS SANDMAN URL.'); }
  if (appUrl.protocol !== 'https:') {
    throw new HttpError(409, 'Stripe seller onboarding requires an HTTPS APP_URL. Test onboarding on the deployed SANDMAN site or an HTTPS tunnel.');
  }

  let accountId = user.stripeConnectAccountId;
  try {
    if (!accountId) {
      const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email.split('@')[0] || 'SANDMAN seller';
      const account = await createMarketplaceRecipientAccount({
        userId: user.id,
        email: user.email,
        displayName,
        country: body.country,
      });
      accountId = account.id;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          stripeConnectAccountId: accountId,
          sellerCountry: body.country,
          stripeConnectPayoutsEnabled: false,
          stripeConnectChargesEnabled: false,
        },
      });
    }

    const accountLink = await createMarketplaceRecipientOnboardingLink({
      accountId,
      refreshUrl: `${appUrl.origin}/seller?tab=payouts&stripe=refresh`,
      returnUrl: `${appUrl.origin}/seller?tab=payouts&stripe=return`,
    });
    res.json({ url: accountLink.url });
  } catch (error) {
    if (error instanceof StripeV2RequestError) {
      if (error.code === 'accounts_v2_access_blocked') {
        throw new HttpError(409, 'Stripe Accounts v2 is not enabled for this platform yet. Enable Accounts v2 in Stripe Connect settings, then retry seller onboarding.');
      }
      throw new HttpError(error.status >= 500 ? 502 : Math.max(400, error.status), error.message);
    }
    throw error;
  }
}));

marketplaceRouter.post('/payout/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) throw new HttpError(503, 'Stripe Connect is not configured');
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user?.stripeConnectAccountId) throw new HttpError(409, 'Connect a payout account first');
  const link = await stripe.accounts.createLoginLink(user.stripeConnectAccountId);
  res.json({ url: link.url });
}));

marketplaceRouter.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.product.findMany({
    where: { sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
    include: { category: true, images: { orderBy: { position: 'asc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(items);
}));

marketplaceRouter.get('/mine/:id', requireAuth, asyncHandler(async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: routeParam(req.params.id, 'id'), sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      fitments: {
        select: {
          vehicleVariantId: true,
          vehicleVariant: {
            select: {
              id: true,
              yearStart: true,
              yearEnd: true,
              trim: true,
              chassisCode: true,
              engineCode: true,
              engineName: true,
              model: { select: { name: true, make: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });
  if (!product) throw new HttpError(404, 'Listing not found');
  res.json(product);
}));

marketplaceRouter.get('/sales', requireAuth, asyncHandler(async (req, res) => {
  const items = await prisma.orderItem.findMany({
    where: {
      sellerId: req.auth!.userId,
      sourceType: 'MARKETPLACE',
      order: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
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
  const data = listingSchema.extend({
    commissionAccepted: z.literal(true),
    publish: z.boolean().default(true),
  }).parse(req.body);
  const seller = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!seller) throw new HttpError(404, 'Seller account not found');
  if (!seller.sellerCommissionAcceptedAt) {
    await prisma.user.update({ where: { id: seller.id }, data: { sellerCommissionAcceptedAt: new Date() } });
  }
  const baseSlug = cleanSlug(data.name) || 'part';
  const slug = `${baseSlug}-${nanoid(7).toLowerCase()}`;
  const sku = `SM-MKT-${nanoid(10).toUpperCase()}`;

  const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
  if (!category) throw new HttpError(400, 'Invalid category');

  const { images, fitmentVehicleVariantIds, commissionAccepted: _commissionAccepted, publish, ...listing } = data;
  assertFitmentMode(listing.requiresFitment, listing.isUniversal);
  const requestedFitmentIds = listing.isUniversal ? [] : await validatedFitmentIds(fitmentVehicleVariantIds);
  const canPublish = Boolean(seller.stripeConnectAccountId && seller.stripeConnectPayoutsEnabled);
  const status = publish && canPublish ? 'ACTIVE' : 'DRAFT';
  if (status === 'ACTIVE') assertPublishableFitment(listing.requiresFitment, listing.isUniversal, requestedFitmentIds);
  const product = await prisma.product.create({
    data: {
      ...listing,
      sku,
      slug,
      sourceType: 'MARKETPLACE',
      sellerId: req.auth!.userId,
      status,
      currency: 'USD',
      taxable: true,
      images: { create: images },
      fitments: { create: requestedFitmentIds.map(vehicleVariantId => ({ vehicleVariantId })) },
    },
    include: {
      category: true,
      images: { orderBy: { position: 'asc' } },
      seller: { select: { id: true, firstName: true, lastName: true, createdAt: true, sellerProfile: true } },
    },
  });

  res.status(201).json({
    ...product,
    publicationBlocked: publish && !canPublish,
    publicationMessage: publish && !canPublish ? 'Listing saved as a draft. Complete seller payout verification before publishing.' : null,
  });
}));

marketplaceRouter.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const existing = await prisma.product.findFirst({
    where: { id, sellerId: req.auth!.userId, sourceType: 'MARKETPLACE' },
    include: { fitments: { select: { vehicleVariantId: true } } },
  });
  if (!existing) throw new HttpError(404, 'Listing not found');

  const data = listingSchema.partial().extend({
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  }).parse(req.body);

  if (data.categoryId && data.categoryId !== existing.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: data.categoryId }, select: { id: true } });
    if (!category) throw new HttpError(400, 'Invalid category');
  }

  const nextStatus = data.status ?? existing.status;
  if (nextStatus === 'ACTIVE') {
    const seller = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { stripeConnectAccountId: true, stripeConnectPayoutsEnabled: true },
    });
    if (!seller?.stripeConnectAccountId || !seller.stripeConnectPayoutsEnabled) {
      throw new HttpError(409, 'Complete seller payout verification before publishing this listing');
    }
  }

  const { images, fitmentVehicleVariantIds, ...productData } = data;
  const requiresFitment = productData.requiresFitment ?? existing.requiresFitment;
  const isUniversal = productData.isUniversal ?? existing.isUniversal;
  assertFitmentMode(requiresFitment, isUniversal);

  const existingFitmentIds = existing.fitments.map(fitment => fitment.vehicleVariantId);
  const submittedFitmentIds = fitmentVehicleVariantIds === undefined
    ? existingFitmentIds
    : await validatedFitmentIds(fitmentVehicleVariantIds);
  const nextFitmentIds = isUniversal ? [] : submittedFitmentIds;
  if (nextStatus === 'ACTIVE') assertPublishableFitment(requiresFitment, isUniversal, nextFitmentIds);

  const shouldReplaceFitments = fitmentVehicleVariantIds !== undefined || isUniversal;
  const product = await prisma.$transaction(async tx => {
    await tx.product.update({ where: { id }, data: productData });
    if (images) {
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (images.length) await tx.productImage.createMany({ data: images.map(image => ({ ...image, productId: id })) });
    }
    if (shouldReplaceFitments) {
      if (nextFitmentIds.length) {
        await tx.productFitment.deleteMany({ where: { productId: id, vehicleVariantId: { notIn: nextFitmentIds } } });
      } else {
        await tx.productFitment.deleteMany({ where: { productId: id } });
      }
      const existingIds = new Set(existingFitmentIds);
      const addedIds = nextFitmentIds.filter(vehicleVariantId => !existingIds.has(vehicleVariantId));
      if (addedIds.length) {
        await tx.productFitment.createMany({ data: addedIds.map(vehicleVariantId => ({ productId: id, vehicleVariantId })) });
      }
    }
    return tx.product.findUnique({
      where: { id },
      include: {
        category: true,
        images: { orderBy: { position: 'asc' } },
        fitments: {
          select: {
            vehicleVariantId: true,
            vehicleVariant: {
              select: {
                id: true,
                yearStart: true,
                yearEnd: true,
                trim: true,
                chassisCode: true,
                engineCode: true,
                engineName: true,
                model: { select: { name: true, make: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });
  });
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
    where: {
      id: routeParam(req.params.orderItemId, 'orderItemId'),
      sellerId: req.auth!.userId,
      sourceType: 'MARKETPLACE',
      order: { paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
    },
    include: { supportCases: { include: { refund: true } } },
  });
  if (!item) throw new HttpError(404, 'Sale item not found');
  const refundedCents = item.supportCases.reduce((sum, supportCase) => {
    return sum + (supportCase.refund?.status === 'SUCCEEDED' ? supportCase.refund.amountCents : 0);
  }, 0);
  const itemPaidCents = Math.max(0, item.totalPriceCents - item.discountCents + item.sellerShippingCents);
  if (itemPaidCents > 0 && refundedCents >= itemPaidCents) {
    throw new HttpError(409, 'This sale item has been fully refunded and must not be shipped');
  }

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

  // Eligibility is recalculated after every shipment. The payout service itself
  // verifies that every non-refunded marketplace line is shipped before money
  // can move, so fully refunded lines cannot leave a seller payout stuck.
  await markMarketplacePayoutReady(item.orderId, req.auth!.userId);
  await processReadyStripeMarketplacePayouts(item.orderId, req.auth!.userId);
  await recomputeOrderFulfillmentStatus(item.orderId);
  const buyerOrder = await prisma.order.findUnique({ where: { id: item.orderId }, select: { userId: true, email: true, orderNumber: true } });
  if (buyerOrder?.userId) await createNotification({ userId: buyerOrder.userId, type: 'SHIPPING', title: 'Marketplace item shipped', body: `${item.name} has shipped.`, link: `#/order/${buyerOrder.orderNumber}` }).catch(() => undefined);
  if (buyerOrder) await sendEmail({ to: buyerOrder.email, subject: `SANDMAN order ${buyerOrder.orderNumber}: item shipped`, text: `${item.name} has shipped via ${body.carrier}. Tracking: ${body.trackingNumber}`, type: 'SHIPPING' }).catch(() => undefined);

  res.json(updated);
}));
