import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';

/**
 * Restore marketplace stock exactly once for an unpaid/cancelled order.
 * This is intentionally not called for transient payment failures because
 * Stripe/PayPal payments can still be retried and later succeed.
 */
export async function releaseMarketplaceStock(orderId: string) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.marketplaceStockReleasedAt) return false;
    if (order.paymentStatus === 'PAID') throw new HttpError(409, 'Paid order stock cannot be released automatically');

    const claimed = await tx.order.updateMany({
      where: { id: orderId, marketplaceStockReleasedAt: null },
      data: { marketplaceStockReleasedAt: new Date() },
    });
    if (!claimed.count) return false;

    for (const item of order.items) {
      if (item.sourceType !== 'MARKETPLACE' || !item.productId) continue;
      await tx.product.updateMany({
        where: { id: item.productId, sourceType: 'MARKETPLACE' },
        data: { stockQuantity: { increment: item.quantity } },
      });
    }
    return true;
  });
}

/**
 * Used only when an external payment session could not be initialized.
 * The cart is deliberately left untouched, marketplace stock is restored,
 * and the orphan local order is removed.
 */
export async function rollbackUninitializedCheckout(orderId: string) {
  await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return;
    if (order.paymentStatus === 'PAID') throw new HttpError(409, 'Cannot roll back a paid checkout');

    for (const item of order.items) {
      if (item.sourceType !== 'MARKETPLACE' || !item.productId) continue;
      await tx.product.updateMany({
        where: { id: item.productId, sourceType: 'MARKETPLACE' },
        data: { stockQuantity: { increment: item.quantity } },
      });
    }
    await tx.order.delete({ where: { id: orderId } });
  });
}

/**
 * Keep the customer-facing order status consistent across mixed orders.
 * Marketplace items count as fulfilled when the seller has supplied shipment
 * tracking. Dropship items count as fulfilled when their fulfillment reaches
 * SHIPPED/DELIVERED.
 */
export async function recomputeOrderFulfillmentStatus(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, fulfillments: true },
  });
  if (!order || order.paymentStatus !== 'PAID') return order?.status;

  const marketplace = order.items.filter(i => i.sourceType === 'MARKETPLACE');
  const dropship = order.items.filter(i => i.sourceType === 'DROPSHIP');

  const marketplaceDone = marketplace.filter(i => Boolean(i.sellerShippedAt)).length;
  const dropshipDone = order.fulfillments.filter(f => f.status === 'SHIPPED' || f.status === 'DELIVERED').length;
  const dropshipExpected = new Set(dropship.map(i => i.supplierId).filter(Boolean)).size;

  const totalUnits = marketplace.length + dropshipExpected;
  const doneUnits = marketplaceDone + dropshipDone;

  let status: 'PROCESSING' | 'SUBMITTED_TO_SUPPLIER' | 'PARTIALLY_FULFILLED' | 'FULFILLED' = 'PROCESSING';
  if (totalUnits > 0 && doneUnits >= totalUnits) status = 'FULFILLED';
  else if (doneUnits > 0) status = 'PARTIALLY_FULFILLED';
  else if (dropshipExpected > 0 && marketplace.length === 0) status = 'SUBMITTED_TO_SUPPLIER';

  await prisma.order.update({ where: { id: orderId }, data: { status } });
  return status;
}
