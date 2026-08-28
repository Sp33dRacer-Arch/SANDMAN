import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getStripe } from './stripe.service';

export async function prepareMarketplacePayouts(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return [];

  const sellerGroups = new Map<string, { amountCents: number; platformFeeCents: number }>();
  for (const item of order.items.filter(i => i.sourceType === 'MARKETPLACE' && i.sellerId)) {
    const current = sellerGroups.get(item.sellerId!) ?? { amountCents: 0, platformFeeCents: 0 };
    current.amountCents += item.sellerPayoutCents ?? 0;
    current.platformFeeCents += item.platformFeeCents ?? 0;
    sellerGroups.set(item.sellerId!, current);
  }

  const records = [];
  for (const [sellerId, totals] of sellerGroups) {
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
  if (payout.status === 'PAID') return payout;

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

  // Promote delayed payouts whose hold period has elapsed.
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
    if (payout.amountCents <= 0) continue;
    const seller = await prisma.user.findUnique({ where: { id: payout.sellerId } });
    if (!seller?.stripeConnectAccountId || !seller.stripeConnectPayoutsEnabled) {
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: { status: 'BLOCKED', errorMessage: 'Seller payout account is not fully onboarded.' },
      });
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: payout.amountCents,
        currency: payout.currency.toLowerCase(),
        destination: seller.stripeConnectAccountId,
        transfer_group: `ORDER_${orderId}`,
        ...(sourceChargeId ? { source_transaction: sourceChargeId } : {}),
        metadata: { orderId, sellerId: payout.sellerId, payoutId: payout.id },
      }, {
        idempotencyKey: `sandman-seller-payout-${payout.id}`,
      });
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: { status: 'PAID', stripeTransferId: transfer.id, paidAt: new Date(), errorMessage: null },
      });
    } catch (error) {
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Stripe transfer failed' },
      });
    }
  }

  return prisma.sellerPayout.findMany({ where: { orderId } });
}
