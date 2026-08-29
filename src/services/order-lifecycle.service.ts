import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';
import { releasePromoUse } from './promo.service';
import { releaseSupplierInventory } from './supplier-inventory.service';
import { computeActiveOrderFulfillmentStatus } from '../lib/fulfillment-status';

/**
 * Restore checkout inventory exactly once for an unpaid/cancelled order.
 * The legacy `marketplaceStockReleasedAt` column is intentionally retained as
 * the order-level "all checkout reservations released" marker so old pending
 * orders remain compatible with the hardened payment-race logic.
 */
export async function releaseCheckoutReservations(orderId: string) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.marketplaceStockReleasedAt) return false;
    if (!['PENDING', 'FAILED'].includes(order.paymentStatus)) throw new HttpError(409, 'Only unpaid, uncaptured order inventory can be released automatically');

    const claimed = await tx.order.updateMany({
      where: {
        id: orderId,
        marketplaceStockReleasedAt: null,
        paymentStatus: { in: ['PENDING', 'FAILED'] },
      },
      data: { marketplaceStockReleasedAt: new Date(), promoCountedAt: null },
    });
    if (!claimed.count) return false;

    if (order.promoCode && order.promoCountedAt) {
      await releasePromoUse(tx, order.promoCode);
    }

    for (const item of order.items) {
      if (item.offerId) {
        // A cancelled order must not keep the unique OrderItem.offerId relation,
        // otherwise the accepted offer could never be used by a replacement order.
        await tx.orderItem.updateMany({ where: { id: item.id, offerId: item.offerId }, data: { offerId: null } });
        await tx.offer.updateMany({
          where: { id: item.offerId, status: 'RESERVED' },
          data: { status: 'ACCEPTED' },
        });
      }

      if (item.sourceType === 'MARKETPLACE' && item.productId) {
        await tx.product.updateMany({
          where: { id: item.productId, sourceType: 'MARKETPLACE' },
          data: { stockQuantity: { increment: item.quantity } },
        });
      }

      if (item.sourceType === 'DROPSHIP'
        && item.supplierLinkId
        && item.supplierStockReservedAt
        && !item.supplierStockReleasedAt
        && !item.supplierStockCommittedAt) {
        const itemClaim = await tx.orderItem.updateMany({
          where: {
            id: item.id,
            supplierStockReservedAt: { not: null },
            supplierStockReleasedAt: null,
            supplierStockCommittedAt: null,
          },
          data: { supplierStockReleasedAt: new Date() },
        });
        if (itemClaim.count === 1) {
          const released = await releaseSupplierInventory(tx, item.supplierLinkId, item.quantity);
          if (!released) throw new HttpError(409, `Supplier reservation for ${item.sku} could not be released safely`);
        }
      }
    }

    await tx.orderEvent.create({
      data: { orderId, type: 'CHECKOUT_RESERVATION_RELEASED', message: 'Unpaid checkout inventory and promo reservations released' },
    });
    return true;
  });
}

// Backwards-compatible export name used by older code paths/tests.
export const releaseMarketplaceStock = releaseCheckoutReservations;

/**
 * Used only when an external payment session could not be initialized.
 * The cart is deliberately left untouched, all inventory is restored,
 * and the orphan local order is removed.
 */
export async function rollbackUninitializedCheckout(orderId: string) {
  await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return;
    if (!['PENDING', 'FAILED'].includes(order.paymentStatus)) throw new HttpError(409, 'Cannot roll back a checkout after payment has been authorized or captured');

    if (order.promoCode && order.promoCountedAt) {
      await releasePromoUse(tx, order.promoCode);
    }

    for (const item of order.items) {
      if (item.offerId) {
        await tx.offer.updateMany({
          where: { id: item.offerId, status: 'RESERVED' },
          data: { status: 'ACCEPTED' },
        });
      }

      if (item.sourceType === 'MARKETPLACE' && item.productId) {
        await tx.product.updateMany({
          where: { id: item.productId, sourceType: 'MARKETPLACE' },
          data: { stockQuantity: { increment: item.quantity } },
        });
      }

      if (item.sourceType === 'DROPSHIP'
        && item.supplierLinkId
        && item.supplierStockReservedAt
        && !item.supplierStockReleasedAt
        && !item.supplierStockCommittedAt) {
        const released = await releaseSupplierInventory(tx, item.supplierLinkId, item.quantity);
        if (!released) throw new HttpError(409, `Supplier reservation for ${item.sku} could not be rolled back safely`);
      }
    }
    await tx.order.delete({ where: { id: orderId } });
  });
}

/**
 * Keep the customer-facing order status consistent across mixed orders.
 * Fully-refunded lines are removed from the fulfillment denominator. A shipped
 * fulfillment only counts when its supplier still has at least one non-refunded
 * dropship line, preventing refunded supplier rows from making a mixed order
 * look fulfilled too early.
 */
export async function recomputeOrderFulfillmentStatus(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { supportCases: { include: { refund: true } } } }, fulfillments: true },
  });
  if (!order || !['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) return order?.status;

  const fullyRefunded = (item: (typeof order.items)[number]) => {
    const refundedCents = item.supportCases.reduce((sum, supportCase) => {
      return sum + (supportCase.refund?.status === 'SUCCEEDED' ? supportCase.refund.amountCents : 0);
    }, 0);
    const paidCents = Math.max(0, item.totalPriceCents - item.discountCents + item.sellerShippingCents);
    return paidCents > 0 && refundedCents >= paidCents;
  };

  const marketplace = order.items.filter(i => i.sourceType === 'MARKETPLACE' && !fullyRefunded(i));
  const dropship = order.items.filter(i => i.sourceType === 'DROPSHIP' && !fullyRefunded(i));

  const marketplaceDone = marketplace.filter(i => Boolean(i.sellerShippedAt)).length;
  const activeDropshipSupplierIds = new Set(dropship.map(i => i.supplierId).filter((id): id is string => Boolean(id)));
  const shippedDropshipSupplierIds = order.fulfillments
    .filter(f => f.status === 'SHIPPED' || f.status === 'DELIVERED')
    .map(f => f.supplierId);

  const status = computeActiveOrderFulfillmentStatus({
    marketplaceOpenLines: marketplace.length,
    marketplaceShippedLines: marketplaceDone,
    activeDropshipSupplierIds,
    shippedDropshipSupplierIds,
  });

  await prisma.order.update({ where: { id: orderId }, data: { status } });
  return status;
}

/**
 * Release supplier inventory holds for dropship lines that are now fully
 * refunded before the supplier accepted them. This is intentionally separate
 * from unpaid checkout cleanup because the payment itself may already have
 * succeeded while fulfillment was still pending.
 */
export async function releaseRefundedSupplierReservations(orderId: string) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { supportCases: { include: { refund: true } } } } },
    });
    if (!order) throw new HttpError(404, 'Order not found');

    let releasedCount = 0;
    for (const item of order.items) {
      if (item.sourceType !== 'DROPSHIP'
        || !item.supplierLinkId
        || !item.supplierStockReservedAt
        || item.supplierStockReleasedAt
        || item.supplierStockCommittedAt) continue;

      const refundedCents = item.supportCases.reduce((sum, supportCase) => {
        return sum + (supportCase.refund?.status === 'SUCCEEDED' ? supportCase.refund.amountCents : 0);
      }, 0);
      const paidCents = Math.max(0, item.totalPriceCents - item.discountCents + item.sellerShippingCents);
      const fullyRefunded = order.paymentStatus === 'REFUNDED' || (paidCents > 0 && refundedCents >= paidCents);
      if (!fullyRefunded) continue;

      const claimed = await tx.orderItem.updateMany({
        where: {
          id: item.id,
          supplierStockReservedAt: { not: null },
          supplierStockReleasedAt: null,
          supplierStockCommittedAt: null,
        },
        data: { supplierStockReleasedAt: new Date() },
      });
      if (claimed.count !== 1) continue;

      const released = await releaseSupplierInventory(tx, item.supplierLinkId, item.quantity);
      if (!released) throw new HttpError(409, `Supplier reservation for ${item.sku} could not be released after refund`);
      releasedCount += 1;
    }
    return releasedCount;
  });
}
