import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getStripe } from './stripe.service';

const ACTIVE_CASE_STATUSES = new Set(['OPEN', 'UNDER_REVIEW', 'AWAITING_SELLER', 'APPROVED']);
const REFUND_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const PAYOUT_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

async function payoutSafetyBlockReason(orderId: string, sellerId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      refunds: {
        where: { status: 'SUCCEEDED' },
        include: { supportCase: { select: { sellerId: true, orderItemId: true } } },
      },
      supportCases: { include: { orderItem: { select: { sourceType: true } } } },
      items: {
        where: { sellerId, sourceType: 'MARKETPLACE' },
        include: { supportCases: { include: { refund: true } } },
      },
    },
  });
  if (!order) return 'Order no longer exists.';
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) return `Order payment status is ${order.paymentStatus}.`;
  if (order.refundInProgressAt && order.refundInProgressAt.getTime() > Date.now() - REFUND_LOCK_TIMEOUT_MS) {
    return 'A refund is currently being processed for this order.';
  }

  const unsafeRefund = order.refunds.some(refund => {
    if (refund.payoutAdjustedAt) return false;
    if (refund.sellerId) return refund.sellerId === sellerId;
    if (refund.supportCase?.orderItemId) return refund.supportCase.sellerId === sellerId;
    // An unallocated whole-order refund can affect every marketplace seller.
    return true;
  });
  if (unsafeRefund) return 'A refund affecting this seller/order has not been allocated to the seller payout yet.';

  const openCase = order.supportCases.some(item => {
    if (!ACTIVE_CASE_STATUSES.has(item.status)) return false;
    if (item.orderItemId) return item.sellerId === sellerId && item.orderItem?.sourceType === 'MARKETPLACE';
    return true;
  });
  if (openCase) return 'A buyer-protection case is still open for this seller/order.';

  const unshippedPayableItem = order.items.some(item => {
    const refundedCents = item.supportCases.reduce((sum, supportCase) => {
      return sum + (supportCase.refund?.status === 'SUCCEEDED' ? supportCase.refund.amountCents : 0);
    }, 0);
    const paidCents = Math.max(0, item.totalPriceCents - item.discountCents + item.sellerShippingCents);
    const fullyRefunded = paidCents > 0 && refundedCents >= paidCents;
    return !fullyRefunded && !item.sellerShippedAt;
  });
  if (unshippedPayableItem) return 'Seller has not shipped all payable marketplace items in this order.';

  return null;
}

export async function blockMarketplacePayoutsForCase(orderId: string, sellerId?: string, reason = 'Buyer-protection review in progress.') {
  return prisma.sellerPayout.updateMany({
    where: {
      orderId,
      ...(sellerId ? { sellerId } : {}),
      status: { in: ['PENDING', 'READY', 'FAILED', 'BLOCKED'] },
    },
    data: { status: 'BLOCKED', errorMessage: reason },
  });
}

export async function prepareMarketplacePayouts(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, refunds: { where: { status: 'SUCCEEDED' } } },
  });
  if (!order) return [];

  const sellerGroups = new Map<string, { amountCents: number; platformFeeCents: number }>();
  for (const item of order.items.filter(i => i.sourceType === 'MARKETPLACE' && i.sellerId)) {
    const current = sellerGroups.get(item.sellerId!) ?? { amountCents: 0, platformFeeCents: 0 };
    current.amountCents += item.sellerPayoutCents ?? 0;
    current.platformFeeCents += item.platformFeeCents ?? 0;
    sellerGroups.set(item.sellerId!, current);
  }

  for (const refund of order.refunds) {
    if (!refund.sellerId || !refund.payoutAdjustedAt) continue;
    const current = sellerGroups.get(refund.sellerId);
    if (!current) continue;
    current.amountCents = Math.max(0, current.amountCents - refund.sellerPayoutAdjustmentCents);
    current.platformFeeCents = Math.max(0, current.platformFeeCents - refund.platformFeeAdjustmentCents);
  }

  const records = [];
  for (const [sellerId, totals] of sellerGroups) {
    const existing = await prisma.sellerPayout.findUnique({ where: { orderId_sellerId: { orderId, sellerId } } });
    if (existing && ['PAID', 'PROCESSING'].includes(existing.status)) {
      records.push(existing);
      continue;
    }
    records.push(await prisma.sellerPayout.upsert({
      where: { orderId_sellerId: { orderId, sellerId } },
      create: {
        orderId,
        sellerId,
        amountCents: totals.amountCents,
        platformFeeCents: totals.platformFeeCents,
        currency: order.currency,
        status: 'PENDING',
      },
      update: {
        amountCents: totals.amountCents,
        platformFeeCents: totals.platformFeeCents,
      },
    }));
  }
  return records;
}

export async function markMarketplacePayoutReady(orderId: string, sellerId: string) {
  const readyAt = new Date(Date.now() + env.MARKETPLACE_PAYOUT_DELAY_DAYS * 86_400_000);
  const payout = await prisma.sellerPayout.findUnique({
    where: { orderId_sellerId: { orderId, sellerId } },
  });
  if (!payout) return null;
  if (['PAID', 'PROCESSING'].includes(payout.status)) return payout;

  const blockReason = await payoutSafetyBlockReason(orderId, sellerId);
  if (blockReason) {
    return prisma.sellerPayout.update({
      where: { id: payout.id },
      data: { status: 'BLOCKED', readyAt, errorMessage: blockReason },
    });
  }

  return prisma.sellerPayout.update({
    where: { id: payout.id },
    data: {
      status: env.MARKETPLACE_PAYOUT_DELAY_DAYS === 0 ? 'READY' : 'PENDING',
      readyAt,
      errorMessage: null,
    },
  });
}

async function stripeSourceCharge(orderId: string) {
  const stripe = getStripe();
  if (!stripe) return undefined;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order?.stripePaymentIntentId) return undefined;
  const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
  return typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
}

export async function processReadyStripeMarketplacePayouts(orderId: string, sellerId?: string) {
  const stripe = getStripe();
  if (!stripe) return prepareMarketplacePayouts(orderId);
  const now = new Date();
  const staleProcessingBefore = new Date(now.getTime() - PAYOUT_PROCESSING_TIMEOUT_MS);

  // Recover a worker/process crash. Stripe transfer creation uses a stable
  // idempotency key, so retrying a stale claim cannot create a second transfer.
  await prisma.sellerPayout.updateMany({
    where: {
      orderId,
      ...(sellerId ? { sellerId } : {}),
      status: 'PROCESSING',
      updatedAt: { lte: staleProcessingBefore },
    },
    data: { status: 'FAILED', errorMessage: 'Previous payout attempt timed out and is safe to retry idempotently.' },
  });

  // Promote delayed payouts whose hold period has elapsed. Safety is checked
  // again immediately before every transfer below.
  await prisma.sellerPayout.updateMany({
    where: {
      orderId,
      ...(sellerId ? { sellerId } : {}),
      status: 'PENDING',
      readyAt: { lte: now },
    },
    data: { status: 'READY' },
  });

  const payouts = await prisma.sellerPayout.findMany({
    where: {
      orderId,
      ...(sellerId ? { sellerId } : {}),
      status: { in: ['READY', 'FAILED', 'BLOCKED'] },
      OR: [{ readyAt: null }, { readyAt: { lte: now } }],
    },
  });
  if (!payouts.length) return prisma.sellerPayout.findMany({ where: { orderId } });

  const sourceChargeId = await stripeSourceCharge(orderId);

  for (const payout of payouts) {
    const blockReason = await payoutSafetyBlockReason(orderId, payout.sellerId);
    if (blockReason) {
      await prisma.sellerPayout.updateMany({
        where: { id: payout.id, status: { in: ['READY', 'FAILED', 'BLOCKED'] } },
        data: { status: 'BLOCKED', errorMessage: blockReason },
      });
      continue;
    }

    // A previously BLOCKED payout may be retried only after the safety check
    // above says the block is gone. Move it back to READY first. If a refund or
    // dispute re-blocks it between this step and the claim, the claim below will
    // fail instead of overriding the new BLOCKED state.
    if (payout.status === 'BLOCKED') {
      const reopened = await prisma.sellerPayout.updateMany({
        where: { id: payout.id, status: 'BLOCKED' },
        data: { status: 'READY', errorMessage: null },
      });
      if (reopened.count !== 1) continue;
      const recheck = await payoutSafetyBlockReason(orderId, payout.sellerId);
      if (recheck) {
        await prisma.sellerPayout.updateMany({
          where: { id: payout.id, status: 'READY' },
          data: { status: 'BLOCKED', errorMessage: recheck },
        });
        continue;
      }
    }

    let destination: string | undefined;
    if (payout.amountCents > 0) {
      const seller = await prisma.user.findUnique({ where: { id: payout.sellerId } });
      if (!seller?.stripeConnectAccountId || !seller.stripeConnectPayoutsEnabled) {
        await prisma.sellerPayout.updateMany({
          where: { id: payout.id, status: { in: ['READY', 'FAILED'] } },
          data: { status: 'BLOCKED', errorMessage: 'Seller payout account is not fully onboarded.' },
        });
        continue;
      }
      destination = seller.stripeConnectAccountId;
    }

    // Atomically claim the payout before any external transfer. A refund sees
    // PROCESSING and refuses to start until this attempt settles. BLOCKED is not
    // claimable here so a newly opened dispute cannot be accidentally overridden.
    const claimed = await prisma.sellerPayout.updateMany({
      where: {
        id: payout.id,
        status: { in: ['READY', 'FAILED'] },
        OR: [{ readyAt: null }, { readyAt: { lte: now } }],
      },
      data: { status: 'PROCESSING', errorMessage: null },
    });
    if (claimed.count !== 1) continue;

    if (payout.amountCents <= 0) {
      await prisma.sellerPayout.updateMany({
        where: { id: payout.id, status: 'PROCESSING' },
        data: { status: 'PAID', paidAt: new Date(), errorMessage: 'Settled with no seller funds due after refund adjustments.' },
      });
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: payout.amountCents,
        currency: payout.currency.toLowerCase(),
        destination: destination!,
        transfer_group: `ORDER_${orderId}`,
        ...(sourceChargeId ? { source_transaction: sourceChargeId } : {}),
        metadata: { orderId, sellerId: payout.sellerId, payoutId: payout.id },
      }, {
        idempotencyKey: `sandman-seller-payout-${payout.id}`,
      });
      await prisma.sellerPayout.updateMany({
        where: { id: payout.id, status: 'PROCESSING' },
        data: { status: 'PAID', stripeTransferId: transfer.id, paidAt: new Date(), errorMessage: null },
      });
    } catch (error) {
      await prisma.sellerPayout.updateMany({
        where: { id: payout.id, status: 'PROCESSING' },
        data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Stripe transfer failed' },
      });
    }
  }

  return prisma.sellerPayout.findMany({ where: { orderId } });
}
