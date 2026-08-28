import { prisma } from '../lib/prisma';
import { submitPaidOrderToSuppliers } from './fulfillment.service';
import { prepareMarketplacePayouts } from './marketplace-payout.service';

export async function finalizePaidOrder(input: {
  orderId: string;
  provider: 'stripe' | 'paypal' | 'manual';
  message?: string;
}) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) return;

  // A payment arriving after stock was explicitly released requires human review.
  if (order.marketplaceStockReleasedAt) {
    if (order.paymentStatus !== 'PAID') {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          status: 'PAID',
          paymentProvider: order.paymentProvider || input.provider,
          internalNote: 'Payment arrived after marketplace stock had been released. Review inventory before fulfillment.',
        },
      });
      await prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'PAYMENT_AFTER_STOCK_RELEASE',
          message: 'Payment received after reserved marketplace stock had already been released. Manual review required.',
        },
      });
    }
    return;
  }

  if (order.paymentStatus !== 'PAID') {
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'PAID', status: 'PAID', paymentProvider: order.paymentProvider || input.provider },
    });
    await prisma.orderEvent.create({
      data: { orderId: order.id, type: 'PAYMENT_SUCCEEDED', message: input.message || `${input.provider.toUpperCase()} payment captured successfully` },
    });
  }

  // Payout records are created at payment time, but seller money is not
  // transferred until that seller actually marks the marketplace item shipped.
  await prepareMarketplacePayouts(order.id);

  // Supplier fulfillment is idempotent per supplier and can safely be called
  // again after a webhook retry.
  await submitPaidOrderToSuppliers(order.id);
}
