import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { finalizePaidOrder } from './payment-finalization.service';
import { releaseCheckoutReservations } from './order-lifecycle.service';
import { getStripe } from './stripe.service';

/**
 * Cancel an unpaid checkout safely before restoring any reserved stock/promo.
 * Stripe must be confirmed cancelled first; a succeeded Stripe payment is
 * finalized instead of releasing inventory. PayPal orders use merchant-side
 * capture, so once the local order is cancelled the capture endpoint refuses it.
 */
export async function cancelUnpaidCheckout(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      paymentProvider: true,
      stripePaymentIntentId: true,
      marketplaceStockReleasedAt: true,
    },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  if (!['PENDING', 'FAILED'].includes(order.paymentStatus)) throw new HttpError(409, 'Only an unpaid order can be cancelled this way');
  if (order.status === 'CANCELLED' && order.marketplaceStockReleasedAt) return { cancelled: true, alreadyCancelled: true };

  if (order.paymentProvider === 'stripe' && order.stripePaymentIntentId) {
    const stripe = getStripe();
    if (!stripe) throw new HttpError(503, 'Stripe is not configured, so this payment session cannot be cancelled safely');
    const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
    if (intent.status === 'succeeded') {
      await finalizePaidOrder({ orderId: order.id, provider: 'stripe', message: 'Stripe payment succeeded before cancellation completed' });
      throw new HttpError(409, 'The Stripe payment already succeeded. The order was finalized instead of cancelled.');
    }
    if (intent.status === 'processing') throw new HttpError(409, 'Stripe is still processing this payment. Try cancellation again after it settles.');

    if (intent.status !== 'canceled') {
      try {
        const cancelled = await stripe.paymentIntents.cancel(order.stripePaymentIntentId);
        if (cancelled.status !== 'canceled') throw new HttpError(409, `Stripe payment is ${cancelled.status} and cannot be released safely`);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const fresh = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId).catch(() => null);
        if (fresh?.status === 'succeeded') {
          await finalizePaidOrder({ orderId: order.id, provider: 'stripe', message: 'Stripe payment won a race with cancellation' });
          throw new HttpError(409, 'The Stripe payment succeeded during cancellation. The order was finalized instead.');
        }
        if (fresh?.status === 'processing') throw new HttpError(409, 'Stripe is still processing this payment. Try cancellation again after it settles.');
        if (fresh?.status !== 'canceled') throw new HttpError(502, 'Stripe cancellation could not be confirmed; inventory was not released');
      }
    }
  }

  await releaseCheckoutReservations(order.id);
  await prisma.order.updateMany({
    where: { id: order.id, paymentStatus: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'CANCELLED' },
  });
  return { cancelled: true, alreadyCancelled: false };
}

/**
 * Release stale checkout inventory/promo reservations so an abandoned
 * payment session cannot hold the last marketplace/supplier item or a limited promo use
 * forever.
 *
 * Stripe is checked before anything is released. Succeeded payments are
 * finalized, processing payments are left alone, and every other live Payment
 * Intent must be cancelled successfully before local reservations are released.
 */
export async function releaseExpiredCheckoutReservations() {
  const cutoff = new Date(Date.now() - env.CHECKOUT_RESERVATION_MINUTES * 60_000);
  const bankTransferCutoff = new Date(Date.now() - env.BANK_TRANSFER_RESERVATION_HOURS * 3_600_000);
  const stale = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentStatus: { in: ['PENDING', 'FAILED'] },
      marketplaceStockReleasedAt: null,
      OR: [
        {
          paymentProvider: { not: 'bank_transfer' },
          createdAt: { lte: cutoff },
          OR: [
            { items: { some: { sourceType: 'MARKETPLACE' } } },
            { items: { some: { sourceType: 'DROPSHIP' } } },
            { promoCode: { not: null } },
          ],
        },
        {
          // Bank transfers need much longer than an online payment session. They
          // cannot contain marketplace items, so after the separate bank-transfer
          // hold window we release promo and uncommitted dropship reservations.
          paymentProvider: 'bank_transfer',
          createdAt: { lte: bankTransferCutoff },
          OR: [
            { items: { some: { sourceType: 'DROPSHIP' } } },
            { promoCode: { not: null } },
          ],
        },
      ],
    },
    select: {
      id: true,
      stripePaymentIntentId: true,
      paymentProvider: true,
    },
    take: 100,
  });

  let released = 0;
  let finalized = 0;
  let skipped = 0;
  const stripe = getStripe();

  for (const order of stale) {
    try {
      if (order.paymentProvider === 'stripe' && order.stripePaymentIntentId) {
        if (!stripe) {
          skipped += 1;
          continue;
        }
        const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
        if (intent.status === 'succeeded') {
          await finalizePaidOrder({ orderId: order.id, provider: 'stripe', message: 'Late Stripe success discovered during reservation cleanup' });
          finalized += 1;
          continue;
        }
        if (intent.status === 'processing') {
          skipped += 1;
          continue;
        }
        if (intent.status !== 'canceled') {
          try {
            const cancelled = await stripe.paymentIntents.cancel(order.stripePaymentIntentId);
            if (cancelled.status !== 'canceled') {
              skipped += 1;
              continue;
            }
          } catch {
            // Payment status may have changed between retrieve() and cancel().
            const fresh = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId).catch(() => null);
            if (fresh?.status === 'succeeded') {
              await finalizePaidOrder({ orderId: order.id, provider: 'stripe', message: 'Stripe success won a race with reservation cleanup' });
              finalized += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
        }
      }

      const didRelease = await releaseCheckoutReservations(order.id);
      if (didRelease) {
        await prisma.order.updateMany({
          where: { id: order.id, paymentStatus: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'CANCELLED' },
        });
        released += 1;
      }
    } catch (error) {
      console.error('Failed to clean stale checkout reservation', order.id, error);
      skipped += 1;
    }
  }

  return { checked: stale.length, released, finalized, skipped };
}
