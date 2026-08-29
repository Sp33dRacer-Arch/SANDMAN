import { prisma } from '../lib/prisma';
import { submitPaidOrderToSuppliers } from './fulfillment.service';
import { prepareMarketplacePayouts } from './marketplace-payout.service';
import { createNotification } from './notification.service';
import { sendEmail } from './email.service';
import { reservePromoUse } from './promo.service';

async function markPaidAfterReservationRelease(input: {
  orderId: string;
  provider: 'stripe' | 'paypal' | 'manual';
}) {
  const claimed = await prisma.order.updateMany({
    where: {
      id: input.orderId,
      marketplaceStockReleasedAt: { not: null },
      paymentStatus: { in: ['PENDING', 'AUTHORIZED', 'FAILED'] },
    },
    data: {
      paymentStatus: 'PAID',
      status: 'PAID',
      paymentProvider: input.provider,
      internalNote: 'Payment arrived after checkout reservations had been released. Review inventory/promo eligibility before fulfillment.',
    },
  });
  if (claimed.count !== 1) return false;

  await prisma.orderEvent.create({
    data: {
      orderId: input.orderId,
      type: 'PAYMENT_AFTER_STOCK_RELEASE',
      message: 'Payment received after checkout reservations had already been released. Manual review required before fulfillment.',
    },
  });
  return true;
}

export async function finalizePaidOrder(input: {
  orderId: string;
  provider: 'stripe' | 'paypal' | 'manual';
  message?: string;
}) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { items: true, user: true } });
  if (!order) return;

  // A payment arriving after a reservation release must never silently recreate
  // sold marketplace stock or over-redeem a promo. Record the payment, then stop
  // before payout/fulfillment so staff can resolve it safely.
  if (order.marketplaceStockReleasedAt) {
    await markPaidAfterReservationRelease({ orderId: order.id, provider: order.paymentProvider === 'stripe' || order.paymentProvider === 'paypal' || order.paymentProvider === 'manual'
      ? order.paymentProvider
      : input.provider });
    return;
  }

  // Claim payment finalization atomically. A checkout-cleanup worker may race the
  // payment webhook, so marketplaceStockReleasedAt must still be null at claim time.
  // Whichever side claims first wins safely.
  const newlyPaid = await prisma.$transaction(async tx => {
    const paidAt = new Date();
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        marketplaceStockReleasedAt: null,
        paymentStatus: { in: ['PENDING', 'AUTHORIZED', 'FAILED'] },
      },
      data: {
        paymentStatus: 'PAID',
        status: 'PAID',
        paymentProvider: order.paymentProvider || input.provider,
      },
    });
    if (claimed.count !== 1) return false;

    // V1.4.1 reserves promo usage during checkout. This fallback only exists for
    // older pending orders created before that change; a captured payment is never
    // rolled back merely because the old promo can no longer be reserved.
    if (order.promoCode && !order.promoCountedAt) {
      const promoReserved = await reservePromoUse(tx, { code: order.promoCode, subtotalCents: order.subtotalCents });
      if (promoReserved) {
        await tx.order.update({ where: { id: order.id }, data: { promoCountedAt: paidAt } });
      } else {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: 'PROMO_USE_NOT_COUNTED',
            message: 'Legacy paid order used a promo that could no longer be reserved. Payment was kept and the order requires promo audit only.',
          },
        });
      }
    }

    await tx.orderEvent.create({
      data: { orderId: order.id, type: 'PAYMENT_SUCCEEDED', message: input.message || `${input.provider.toUpperCase()} payment captured successfully` },
    });

    for (const item of order.items) {
      if (item.productId) await tx.product.updateMany({ where: { id: item.productId }, data: { purchaseCount: { increment: item.quantity } } });
      if (item.offerId) {
        await tx.offer.updateMany({
          where: { id: item.offerId, status: 'RESERVED' },
          data: { status: 'PURCHASED', purchasedAt: paidAt },
        });
      }
    }

    const marketplaceBySeller = new Map<string, number>();
    for (const item of order.items) {
      if (item.sourceType === 'MARKETPLACE' && item.sellerId) {
        marketplaceBySeller.set(item.sellerId, (marketplaceBySeller.get(item.sellerId) ?? 0) + item.quantity);
      }
    }
    for (const [sellerId, count] of marketplaceBySeller) {
      await tx.sellerProfile.upsert({
        where: { userId: sellerId },
        update: { totalSales: { increment: count } },
        create: { userId: sellerId, totalSales: count },
      });
    }
    return true;
  });

  if (!newlyPaid) {
    const latest = await prisma.order.findUnique({
      where: { id: order.id },
      select: { marketplaceStockReleasedAt: true, paymentStatus: true, paymentProvider: true },
    });

    // Checkout cleanup may have won the race after our initial read.
    if (latest?.marketplaceStockReleasedAt) {
      await markPaidAfterReservationRelease({
        orderId: order.id,
        provider: latest.paymentProvider === 'stripe' || latest.paymentProvider === 'paypal' || latest.paymentProvider === 'manual'
          ? latest.paymentProvider
          : input.provider,
      });
      return;
    }

    // A duplicate webhook/capture request is fine; downstream operations are
    // idempotent and may be retried if the first worker crashed after payment.
    if (latest?.paymentStatus !== 'PAID') return;
  }

  if (newlyPaid) {
    if (order.userId) {
      await createNotification({ userId: order.userId, type: 'ORDER', title: 'Payment confirmed', body: `Order ${order.orderNumber} is paid.`, link: `#/order/${order.orderNumber}` }).catch(() => undefined);
    }
    const sellerIds: string[] = [...new Set<string>(order.items.filter(i => i.sourceType === 'MARKETPLACE' && i.sellerId).map(i => i.sellerId as string))];
    for (const sellerId of sellerIds) {
      await createNotification({ userId: sellerId, type: 'SALE', title: 'You made a sale', body: `A marketplace item sold in order ${order.orderNumber}.`, link: '#/seller?tab=sales' }).catch(() => undefined);
    }
    await sendEmail({
      to: order.email,
      subject: `SANDMAN order ${order.orderNumber} confirmed`,
      text: `Payment received for order ${order.orderNumber}. Total: ${(order.totalCents / 100).toFixed(2)} ${order.currency}.`,
      type: 'ORDER',
    }).catch(() => undefined);
  }

  // Do not recreate payouts or fulfillment after an order has already moved into
  // a refunded state and a late duplicate payment event arrives.
  const current = await prisma.order.findUnique({ where: { id: order.id }, select: { paymentStatus: true, marketplaceStockReleasedAt: true } });
  if (current?.paymentStatus !== 'PAID' || current.marketplaceStockReleasedAt) return;

  // Payout records are created at payment time, but seller money is not
  // transferred until that seller actually marks the marketplace item shipped.
  await prepareMarketplacePayouts(order.id);

  // Supplier fulfillment is idempotent per supplier and can safely be called
  // again after a webhook retry.
  await submitPaidOrderToSuppliers(order.id);
}
