import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { createNotification } from '../../services/notification.service';
import { getStripe } from '../../services/stripe.service';
import { refundPayPalOrder } from '../../services/paypal.service';
import { blockMarketplacePayoutsForCase, markMarketplacePayoutReady, prepareMarketplacePayouts, processReadyStripeMarketplacePayouts } from '../../services/marketplace-payout.service';
import { recomputeOrderFulfillmentStatus, releaseRefundedSupplierReservations } from '../../services/order-lifecycle.service';
import { isSandmanCloudinaryUrl } from '../../lib/media-url';

export const supportRouter = Router();
supportRouter.use(requireAuth);

const REFUND_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

function itemNetPaidCents(item: { totalPriceCents: number; discountCents: number; sellerShippingCents?: number }) {
  return Math.max(0, item.totalPriceCents - item.discountCents + (item.sellerShippingCents ?? 0));
}

supportRouter.get('/cases', asyncHandler(async (req, res) => {
  const items = await prisma.supportCase.findMany({
    where: { userId: req.auth!.userId },
    include: { order: { select: { orderNumber: true, totalCents: true, currency: true } }, orderItem: { select: { name: true, sku: true, totalPriceCents: true, discountCents: true, sellerShippingCents: true } }, refund: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(items);
}));

supportRouter.post('/cases', asyncHandler(async (req, res) => {
  const body = z.object({
    orderNumber: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    orderItemId: z.string().optional(),
    type: z.enum(['RETURN', 'NOT_RECEIVED', 'WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'COUNTERFEIT', 'OTHER']),
    reason: z.string().trim().min(5).max(300),
    details: z.string().trim().max(4000).optional(),
    evidenceUrls: z.array(z.string().url().refine(isSandmanCloudinaryUrl, 'Evidence images must use a SANDMAN image upload')).max(8).default([]),
    requestedRefundCents: z.number().int().positive().optional(),
  }).refine(value => Boolean(value.orderNumber || value.orderId), { message: 'Order number or order id is required' }).parse(req.body);

  const order = await prisma.order.findFirst({
    where: {
      userId: req.auth!.userId,
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
      ...(body.orderNumber ? { orderNumber: body.orderNumber } : { id: body.orderId! }),
    },
    include: { items: true },
  });
  if (!order) throw new HttpError(404, 'Paid order not found');
  const orderItem = body.orderItemId ? order.items.find(item => item.id === body.orderItemId) : undefined;
  if (body.orderItemId && !orderItem) throw new HttpError(404, 'Order item not found');
  const maxRefund = orderItem ? itemNetPaidCents(orderItem) : order.totalCents;
  if (body.requestedRefundCents && body.requestedRefundCents > maxRefund) throw new HttpError(400, 'Requested refund is higher than the eligible item/order value');

  const supportCase = await prisma.supportCase.create({
    data: {
      userId: req.auth!.userId,
      orderId: order.id,
      orderItemId: orderItem?.id,
      sellerId: orderItem?.sellerId,
      type: body.type,
      reason: body.reason,
      details: body.details,
      evidenceUrls: body.evidenceUrls as Prisma.InputJsonValue,
      requestedRefundCents: body.requestedRefundCents,
    },
  });
  await prisma.orderEvent.create({ data: { orderId: order.id, type: 'BUYER_PROTECTION_CASE_OPENED', message: `Buyer protection case opened: ${body.type}` } });

  // Freeze only the affected marketplace seller. A dropship-only item case does
  // not freeze unrelated marketplace sellers; a true whole-order case freezes all.
  if (!orderItem || orderItem.sellerId) {
    await blockMarketplacePayoutsForCase(order.id, orderItem?.sellerId ?? undefined).catch(() => undefined);
  }
  if (orderItem?.sellerId) await createNotification({ userId: orderItem.sellerId, type: 'CASE', title: 'Buyer protection case', body: `A case was opened for ${orderItem.name}.`, link: '#/seller?tab=cases' });
  res.status(201).json(supportCase);
}));

supportRouter.get('/seller/cases', asyncHandler(async (req, res) => {
  const items = await prisma.supportCase.findMany({
    where: { sellerId: req.auth!.userId },
    include: {
      user: { select: { id: true, firstName: true, lastName: true } },
      order: { select: { id: true, orderNumber: true, currency: true, createdAt: true } },
      orderItem: { select: { id: true, name: true, sku: true, totalPriceCents: true, discountCents: true, sellerShippingCents: true, sellerTrackingNumber: true, sellerCarrier: true, sellerShippedAt: true } },
      refund: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(items);
}));

supportRouter.post('/seller/cases/:id/respond', asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const body = z.object({ response: z.string().trim().min(5).max(4000) }).parse(req.body);
  const supportCase = await prisma.supportCase.findFirst({ where: { id, sellerId: req.auth!.userId } });
  if (!supportCase) throw new HttpError(404, 'Case not found');
  if (['RESOLVED', 'CLOSED', 'REJECTED'].includes(supportCase.status)) throw new HttpError(409, 'This case is already closed');

  const updated = await prisma.supportCase.update({
    where: { id },
    data: {
      sellerResponse: body.response,
      sellerRespondedAt: new Date(),
      status: supportCase.status === 'APPROVED' ? 'APPROVED' : 'UNDER_REVIEW',
    },
  });
  await createNotification({ userId: supportCase.userId, type: 'CASE', title: 'Seller responded', body: 'The seller responded to your buyer-protection case.', link: '#/account?tab=cases' }).catch(() => undefined);
  res.json(updated);
}));

supportRouter.get('/admin/cases', requireRole('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const items = await prisma.supportCase.findMany({
    where: status ? { status: status as any } : {},
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
      order: { include: { refunds: true } },
      orderItem: true,
      refund: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(items);
}));

supportRouter.patch('/admin/cases/:id', requireRole('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.enum(['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED', 'REJECTED', 'RESOLVED', 'CLOSED']).optional(),
    resolution: z.string().max(4000).optional(),
    approvedRefundCents: z.number().int().positive().optional(),
  }).parse(req.body);
  const supportCase = await prisma.supportCase.findUnique({ where: { id: routeParam(req.params.id, 'id') }, include: { order: true, orderItem: true } });
  if (!supportCase) throw new HttpError(404, 'Case not found');
  const maxRefund = supportCase.orderItem ? itemNetPaidCents(supportCase.orderItem) : supportCase.order.totalCents;
  if (body.approvedRefundCents && body.approvedRefundCents > maxRefund) throw new HttpError(400, 'Approved refund exceeds eligible value');
  const updated = await prisma.supportCase.update({ where: { id: supportCase.id }, data: body });

  if (['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED'].includes(updated.status)) {
    if (!supportCase.orderItemId || updated.sellerId) {
      await blockMarketplacePayoutsForCase(updated.orderId, updated.sellerId ?? undefined).catch(() => undefined);
    }
  } else if (updated.sellerId && ['REJECTED', 'CLOSED'].includes(updated.status)) {
    const unshipped = await prisma.orderItem.count({ where: { orderId: updated.orderId, sellerId: updated.sellerId, sourceType: 'MARKETPLACE', sellerShippedAt: null } });
    if (unshipped === 0) {
      await markMarketplacePayoutReady(updated.orderId, updated.sellerId).catch(() => undefined);
      await processReadyStripeMarketplacePayouts(updated.orderId, updated.sellerId).catch(() => undefined);
    }
  }

  await createNotification({ userId: supportCase.userId, type: 'CASE', title: 'Case updated', body: `Your case is now ${updated.status.toLowerCase().replaceAll('_', ' ')}.`, link: '#/account?tab=cases' });
  res.json(updated);
}));

supportRouter.post('/admin/cases/:id/refund', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const body = z.object({ amountCents: z.number().int().positive() }).parse(req.body);

  const caseRef = await prisma.supportCase.findUnique({ where: { id }, select: { id: true, orderId: true } });
  if (!caseRef) throw new HttpError(404, 'Case not found');

  // Only one refund may be in flight for an order. This protects the provider
  // call and the local refund totals from concurrent admin requests.
  const now = new Date();
  const staleBefore = new Date(now.getTime() - REFUND_LOCK_TIMEOUT_MS);
  const claim = await prisma.order.updateMany({
    where: {
      id: caseRef.orderId,
      OR: [{ refundInProgressAt: null }, { refundInProgressAt: { lt: staleBefore } }],
    },
    data: { refundInProgressAt: now, refundInProgressCaseId: id },
  });
  if (claim.count !== 1) throw new HttpError(409, 'Another refund is already being processed for this order. Try again shortly.');

  let lockHeld = true;
  try {
    // Re-read everything after taking the lock so eligibility is calculated
    // from the latest refund/payout state.
    const supportCase = await prisma.supportCase.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            sellerPayouts: true,
            refunds: { include: { supportCase: { select: { orderItemId: true, sellerId: true } } } },
          },
        },
        orderItem: true,
        refund: true,
      },
    });
    if (!supportCase) throw new HttpError(404, 'Case not found');
    if (supportCase.refund) throw new HttpError(409, 'This case already has a refund record');
    if (!['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED'].includes(supportCase.status)) {
      throw new HttpError(409, 'Only an active or approved buyer-protection case can issue an automated refund.');
    }

    const order = supportCase.order;
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) throw new HttpError(409, 'Order is not refundable');

    if (!supportCase.orderItemId && order.sellerPayouts.length > 0) {
      throw new HttpError(409, 'Marketplace refunds must target a specific order item so the correct seller payout can be adjusted safely.');
    }

    const affectedPayouts = supportCase.sellerId
      ? order.sellerPayouts.filter(payout => payout.sellerId === supportCase.sellerId)
      : supportCase.orderItemId
        ? []
        : order.sellerPayouts;
    if (affectedPayouts.some(payout => payout.status === 'PROCESSING')) {
      throw new HttpError(409, 'An affected seller payout transfer is currently in progress. Try the refund again shortly.');
    }
    if (affectedPayouts.some(payout => payout.status === 'PAID')) {
      throw new HttpError(409, 'An affected marketplace seller payout has already been transferred. Recover/resolve the seller funds before refunding this order.');
    }

    const succeededRefunds = order.refunds.filter(refund => refund.status === 'SUCCEEDED');
    const alreadyRefunded = succeededRefunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    const remaining = Math.max(0, order.totalCents - alreadyRefunded);
    const itemAlreadyRefunded = supportCase.orderItem
      ? succeededRefunds
        .filter(refund => refund.supportCase?.orderItemId === supportCase.orderItem!.id)
        .reduce((sum, refund) => sum + refund.amountCents, 0)
      : 0;
    const itemRemaining = supportCase.orderItem
      ? Math.max(0, itemNetPaidCents(supportCase.orderItem) - itemAlreadyRefunded)
      : remaining;
    const eligible = Math.min(remaining, itemRemaining);
    if (eligible <= 0) throw new HttpError(409, 'There is no refundable value remaining for this case.');
    if (body.amountCents > eligible) throw new HttpError(400, 'Refund amount exceeds remaining eligible value');

    let sellerPayoutAdjustmentCents = 0;
    let platformFeeAdjustmentCents = 0;
    if (supportCase.orderItem?.sourceType === 'MARKETPLACE' && supportCase.orderItem.sellerId && itemRemaining > 0) {
      const priorSellerAdjustment = succeededRefunds
        .filter(refund => refund.supportCase?.orderItemId === supportCase.orderItem!.id)
        .reduce((sum, refund) => sum + refund.sellerPayoutAdjustmentCents, 0);
      const priorPlatformAdjustment = succeededRefunds
        .filter(refund => refund.supportCase?.orderItemId === supportCase.orderItem!.id)
        .reduce((sum, refund) => sum + refund.platformFeeAdjustmentCents, 0);
      const originalSellerPayout = Math.max(0, supportCase.orderItem.sellerPayoutCents ?? 0);
      const remainingSellerPayout = Math.max(0, originalSellerPayout - priorSellerAdjustment);
      const remainingPlatformFee = Math.max(0, supportCase.orderItem.platformFeeCents - priorPlatformAdjustment);

      if (body.amountCents >= itemRemaining) {
        sellerPayoutAdjustmentCents = remainingSellerPayout;
        platformFeeAdjustmentCents = remainingPlatformFee;
      } else {
        sellerPayoutAdjustmentCents = Math.min(remainingSellerPayout, Math.floor((body.amountCents * remainingSellerPayout) / itemRemaining));
        platformFeeAdjustmentCents = Math.min(remainingPlatformFee, Math.floor((body.amountCents * remainingPlatformFee) / itemRemaining));
      }
    }

    // Freeze unpaid payouts before contacting the payment provider. The order
    // refund lock also causes payoutSafetyBlockReason() to refuse a new transfer.
    if (supportCase.sellerId) {
      await blockMarketplacePayoutsForCase(order.id, supportCase.sellerId, 'Refund is being processed for this buyer-protection case.');
    } else if (!supportCase.orderItemId) {
      await blockMarketplacePayoutsForCase(order.id, undefined, 'Refund is being processed for this buyer-protection case.');
    }

    // Catch a payout worker that may have claimed the transfer immediately
    // before the refund lock became visible.
    const payoutRace = supportCase.sellerId
      ? await prisma.sellerPayout.findMany({ where: { orderId: order.id, sellerId: supportCase.sellerId } })
      : supportCase.orderItemId
        ? []
        : await prisma.sellerPayout.findMany({ where: { orderId: order.id } });
    if (payoutRace.some(payout => payout.status === 'PROCESSING')) {
      throw new HttpError(409, 'An affected seller payout transfer started just before this refund. Try again after it finishes.');
    }
    if (payoutRace.some(payout => payout.status === 'PAID')) {
      throw new HttpError(409, 'An affected marketplace seller payout has already been transferred. Recover/resolve the seller funds before refunding this order.');
    }

    let externalRefundId: string | undefined;
    const provider = order.paymentProvider || 'manual';
    if (provider === 'stripe') {
      if (!order.stripePaymentIntentId) throw new HttpError(409, 'Stripe payment reference is missing');
      const stripe = getStripe();
      if (!stripe) throw new HttpError(503, 'Stripe is not configured');
      const refund = await stripe.refunds.create(
        { payment_intent: order.stripePaymentIntentId, amount: body.amountCents },
        { idempotencyKey: `sandman-case-refund-${supportCase.id}` },
      );
      externalRefundId = refund.id;
    } else if (provider === 'paypal') {
      if (!order.paypalOrderId) throw new HttpError(409, 'PayPal order reference is missing');
      const refund = await refundPayPalOrder(order.paypalOrderId, body.amountCents, order.currency, `refund-${supportCase.id}`);
      externalRefundId = refund.id;
    } else {
      throw new HttpError(409, 'This payment method requires a manual refund outside SANDMAN. Record the case resolution after sending it.');
    }

    const totalRefunded = alreadyRefunded + body.amountCents;
    const full = totalRefunded >= order.totalCents;
    const result = await prisma.$transaction(async tx => {
      const payout = supportCase.sellerId
        ? await tx.sellerPayout.findUnique({ where: { orderId_sellerId: { orderId: order.id, sellerId: supportCase.sellerId } } })
        : null;
      const payoutCanBeAdjusted = !payout || !['PAID', 'PROCESSING'].includes(payout.status);
      const sellerAdjustment = supportCase.sellerId ? sellerPayoutAdjustmentCents : 0;
      const feeAdjustment = supportCase.sellerId ? platformFeeAdjustmentCents : 0;

      const refund = await tx.refundRecord.create({
        data: {
          orderId: order.id,
          supportCaseId: supportCase.id,
          sellerId: supportCase.sellerId,
          amountCents: body.amountCents,
          sellerPayoutAdjustmentCents: sellerAdjustment,
          platformFeeAdjustmentCents: feeAdjustment,
          // No payout row yet is safe: prepareMarketplacePayouts() will apply
          // these recorded adjustments when it creates the row later.
          payoutAdjustedAt: supportCase.sellerId && payoutCanBeAdjusted ? new Date() : undefined,
          currency: order.currency,
          provider,
          externalRefundId,
          status: 'SUCCEEDED',
        },
      });

      if (payout && payoutCanBeAdjusted) {
        await tx.sellerPayout.update({
          where: { id: payout.id },
          data: {
            amountCents: Math.max(0, payout.amountCents - Math.min(sellerAdjustment, payout.amountCents)),
            platformFeeCents: Math.max(0, payout.platformFeeCents - Math.min(feeAdjustment, payout.platformFeeCents)),
            status: 'BLOCKED',
            readyAt: null,
            errorMessage: 'Refund adjustment applied; payout eligibility will be recalculated.',
          },
        });
      }

      await tx.supportCase.update({
        where: { id: supportCase.id },
        data: {
          status: 'RESOLVED',
          approvedRefundCents: body.amountCents,
          resolution: supportCase.resolution || 'Refund issued',
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          ...(full ? { status: 'REFUNDED' } : {}),
          refundInProgressAt: null,
          refundInProgressCaseId: null,
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'REFUND_ISSUED',
          message: `${provider} refund issued`,
          metadata: {
            supportCaseId: supportCase.id,
            amountCents: body.amountCents,
            externalRefundId,
            payoutAdjustmentRecorded: payoutCanBeAdjusted,
          },
        },
      });
      return refund;
    });
    lockHeld = false;

    // A full refund can happen before the supplier order is submitted. Release
    // any still-pending dropship inventory hold so refunded stock is not leaked.
    await releaseRefundedSupplierReservations(order.id).catch(async error => {
      await prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'SUPPLIER_RESERVATION_RELEASE_FAILED',
          message: error instanceof Error ? error.message.slice(0, 1000) : 'Refunded supplier reservation could not be released',
        },
      }).catch(() => undefined);
    });
    await recomputeOrderFulfillmentStatus(order.id).catch(() => undefined);

    if (supportCase.sellerId) {
      await prepareMarketplacePayouts(order.id);
      const activeCases = await prisma.supportCase.count({
        where: {
          orderId: order.id,
          sellerId: supportCase.sellerId,
          status: { in: ['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED'] },
        },
      });
      if (activeCases === 0) {
        await markMarketplacePayoutReady(order.id, supportCase.sellerId).catch(() => undefined);
        await processReadyStripeMarketplacePayouts(order.id, supportCase.sellerId).catch(() => undefined);
      }
    }

    await createNotification({
      userId: supportCase.userId,
      type: 'REFUND',
      title: 'Refund issued',
      body: `A refund was issued for your order ${order.orderNumber}.`,
      link: `#/order/${order.orderNumber}`,
    });
    res.json(result);
  } finally {
    if (lockHeld) {
      await prisma.order.updateMany({
        where: { id: caseRef.orderId, refundInProgressCaseId: id },
        data: { refundInProgressAt: null, refundInProgressCaseId: null },
      }).catch(() => undefined);
    }
  }
}));
