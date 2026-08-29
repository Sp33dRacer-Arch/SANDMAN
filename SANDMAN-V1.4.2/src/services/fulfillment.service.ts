import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { supplierAdapterFor } from './supplier-registry';
import { HttpError } from '../lib/http-error';
import { recomputeOrderFulfillmentStatus } from './order-lifecycle.service';
import { commitSupplierInventory } from './supplier-inventory.service';

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

async function commitSupplierReservations(items: Array<{
  id: string;
  sku: string;
  quantity: number;
  supplierLinkId: string | null;
  supplierStockReservedAt: Date | null;
  supplierStockReleasedAt: Date | null;
  supplierStockCommittedAt: Date | null;
}>) {
  await prisma.$transaction(async tx => {
    for (const item of items) {
      if (!item.supplierStockReservedAt || item.supplierStockReleasedAt || item.supplierStockCommittedAt) continue;
      if (!item.supplierLinkId) throw new HttpError(409, `Supplier reservation for ${item.sku} is missing its supplier link`);
      const claimed = await tx.orderItem.updateMany({
        where: {
          id: item.id,
          supplierStockReservedAt: { not: null },
          supplierStockReleasedAt: null,
          supplierStockCommittedAt: null,
        },
        data: { supplierStockCommittedAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      const committed = await commitSupplierInventory(tx, item.supplierLinkId, item.quantity);
      if (!committed) throw new HttpError(409, `Supplier reservation for ${item.sku} could not be committed safely`);
    }
  });
}

export async function submitPaidOrderToSuppliers(orderId: string, options: { retryFailed?: boolean } = {}) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { supportCases: { include: { refund: true } } } }, fulfillments: true },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) throw new HttpError(409, 'Order must be paid before supplier submission');

  const address = order.shippingAddress as unknown as ShippingAddress;
  const fullyRefunded = (item: (typeof order.items)[number]) => {
    const refundedCents = item.supportCases.reduce((sum, supportCase) => {
      return sum + (supportCase.refund?.status === 'SUCCEEDED' ? supportCase.refund.amountCents : 0);
    }, 0);
    const paidCents = Math.max(0, item.totalPriceCents - item.discountCents + item.sellerShippingCents);
    return paidCents > 0 && refundedCents >= paidCents;
  };

  const dropshipItems = order.items.filter(item => item.sourceType === 'DROPSHIP' && !fullyRefunded(item));
  const marketplaceItems = order.items.filter(item => item.sourceType === 'MARKETPLACE' && !fullyRefunded(item));

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

    const fulfillment = await prisma.fulfillment.upsert({
      where: { orderId_supplierId: { orderId, supplierId } },
      create: { orderId, supplierId, status: 'PENDING' },
      update: {},
    });

    if (['SUBMITTED', 'ACCEPTED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(fulfillment.status)) {
      // Repair a rare crash window where the supplier accepted the order but the
      // local reservation commit did not finish. The per-item claim is idempotent.
      try {
        await commitSupplierReservations(items);
        results.push(fulfillment);
      } catch (error) {
        const noted = await prisma.fulfillment.update({
          where: { id: fulfillment.id },
          data: { errorMessage: error instanceof Error ? `Supplier order exists; local stock commit pending: ${error.message}`.slice(0, 1000) : 'Supplier order exists; local stock commit pending' },
        });
        results.push(noted);
      }
      continue;
    }
    if (fulfillment.status === 'FAILED' && !options.retryFailed) {
      results.push(fulfillment);
      continue;
    }

    let updated;
    try {
      const adapter = supplierAdapterFor(supplier);
      const result = await adapter.submitOrder({
        reference: `${order.orderNumber}-${supplier.code}`,
        shippingAddress: address,
        items: items.map(i => ({
          supplierProductId: i.supplierProductId!,
          sku: i.sku,
          quantity: i.quantity,
        })),
      });

      // Persist the external supplier order before touching local reservation
      // counters. If the next step fails, retries see this fulfillment and repair
      // the local commit instead of submitting a duplicate supplier order.
      updated = await prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: result.status === 'accepted' ? 'ACCEPTED' : 'PROCESSING',
          supplierOrderId: result.supplierOrderId,
          rawResponse: (result.raw ?? {}) as Prisma.InputJsonValue,
          submittedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      const failed = await prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Supplier submission failed' },
      });
      results.push(failed);
      // Do not rethrow: one supplier outage must not hide successful fulfillment
      // submissions for the rest of a mixed order. Admin can retry the failed row.
      continue;
    }

    try {
      await commitSupplierReservations(items);
      results.push(updated);
    } catch (error) {
      const noted = await prisma.fulfillment.update({
        where: { id: fulfillment.id },
        data: { errorMessage: error instanceof Error ? `Supplier order accepted; local stock commit pending: ${error.message}`.slice(0, 1000) : 'Supplier order accepted; local stock commit pending' },
      });
      results.push(noted);
    }
  }

  if (marketplaceItems.length) {
    const existing = await prisma.orderEvent.findFirst({
      where: { orderId, type: 'MARKETPLACE_SELLER_FULFILLMENT_REQUIRED' },
    });
    if (!existing) {
      await prisma.orderEvent.create({
        data: {
          orderId,
          type: 'MARKETPLACE_SELLER_FULFILLMENT_REQUIRED',
          message: `${marketplaceItems.length} marketplace item(s) are awaiting seller shipment`,
        },
      });
    }
  }

  if (dropshipItems.length) {
    const existing = await prisma.orderEvent.findFirst({ where: { orderId, type: 'SUPPLIER_SUBMISSION' } });
    if (!existing) {
      await prisma.orderEvent.create({ data: { orderId, type: 'SUPPLIER_SUBMISSION', message: 'Dropship item(s) submitted to supplier(s)' } });
    }
  }

  await recomputeOrderFulfillmentStatus(orderId);
  return results;
}
