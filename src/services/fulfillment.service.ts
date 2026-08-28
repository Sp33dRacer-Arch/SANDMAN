import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { supplierAdapterFor } from './supplier-registry';
import { HttpError } from '../lib/http-error';

type ShippingAddress = {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
};

export async function submitPaidOrderToSuppliers(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, fulfillments: true },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.paymentStatus !== 'PAID') throw new HttpError(409, 'Order must be paid before supplier submission');
  if (order.fulfillments.length) return order.fulfillments;

  const address = order.shippingAddress as unknown as ShippingAddress;
  const dropshipItems = order.items.filter(item => item.sourceType === 'DROPSHIP');
  const marketplaceItems = order.items.filter(item => item.sourceType === 'MARKETPLACE');

  const grouped = new Map<string, typeof dropshipItems>();
  for (const item of dropshipItems) {
    if (!item.supplierId || !item.supplierProductId) throw new HttpError(409, `Order item ${item.sku} has no supplier assignment`);
    const group = grouped.get(item.supplierId) ?? [];
    group.push(item);
    grouped.set(item.supplierId, group);
  }

  const results = [];
  for (const [supplierId, items] of grouped) {
    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new HttpError(409, 'Assigned supplier no longer exists');
    const fulfillment = await prisma.fulfillment.create({ data: { orderId, supplierId, status: 'PENDING' } });

    try {
      const adapter = supplierAdapterFor(supplier);
      const result = await adapter.submitOrder({
        reference: order.orderNumber,
        shippingAddress: address,
        items: items.map(i => ({
          supplierProductId: i.supplierProductId!,
          sku: i.sku,
          quantity: i.quantity,
        })),
      });

      const updated = await prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: result.status === 'accepted' ? 'ACCEPTED' : 'PROCESSING',
          supplierOrderId: result.supplierOrderId,
          rawResponse: (result.raw ?? {}) as Prisma.InputJsonValue,
          submittedAt: new Date(),
        },
      });
      results.push(updated);
    } catch (error) {
      await prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message : 'Supplier submission failed' },
      });
      throw error;
    }
  }

  if (marketplaceItems.length) {
    await prisma.orderEvent.create({
      data: {
        orderId,
        type: 'MARKETPLACE_SELLER_FULFILLMENT_REQUIRED',
        message: `${marketplaceItems.length} marketplace item(s) are awaiting seller shipment`,
      },
    });
  }

  const nextStatus = marketplaceItems.length ? 'PROCESSING' : dropshipItems.length ? 'SUBMITTED_TO_SUPPLIER' : 'PROCESSING';
  await prisma.order.update({ where: { id: orderId }, data: { status: nextStatus } });
  if (dropshipItems.length) {
    await prisma.orderEvent.create({ data: { orderId, type: 'SUPPLIER_SUBMISSION', message: 'Dropship item(s) submitted to supplier(s)' } });
  }
  return results;
}
