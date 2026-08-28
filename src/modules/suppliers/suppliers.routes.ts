import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { requireAuth, requireRole } from '../../middleware/auth';
import { supplierAdapterFor } from '../../services/supplier-registry';

export const suppliersRouter = Router();
suppliersRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

suppliersRouter.get('/', asyncHandler(async (_req, res) => {
  const suppliers = await prisma.supplier.findMany({
    include: { _count: { select: { products: true, fulfillments: true } } },
    orderBy: [{ active: 'desc' }, { priority: 'asc' }],
  });
  res.json(suppliers);
}));

suppliersRouter.post('/fulfillments/:id/refresh', asyncHandler(async (req, res) => {
  const fulfillment = await prisma.fulfillment.findUnique({
    where: { id: req.params.id },
    include: { supplier: true },
  });
  if (!fulfillment) throw new HttpError(404, 'Fulfillment not found');
  if (!fulfillment.supplierOrderId) throw new HttpError(409, 'Fulfillment has not been submitted yet');

  const adapter = supplierAdapterFor(fulfillment.supplier);
  const tracking = await adapter.getTracking(fulfillment.supplierOrderId);
  const status = tracking.status === 'shipped' ? 'SHIPPED'
    : tracking.status === 'delivered' ? 'DELIVERED'
    : tracking.status === 'cancelled' ? 'CANCELLED'
    : 'PROCESSING';

  const updated = await prisma.fulfillment.update({
    where: { id: fulfillment.id },
    data: {
      status,
      trackingNumber: tracking.trackingNumber,
      trackingUrl: tracking.trackingUrl,
      carrier: tracking.carrier,
      shippedAt: tracking.status === 'shipped' && !fulfillment.shippedAt ? new Date() : fulfillment.shippedAt,
      deliveredAt: tracking.status === 'delivered' && !fulfillment.deliveredAt ? new Date() : fulfillment.deliveredAt,
    },
  });

  const all = await prisma.fulfillment.findMany({ where: { orderId: fulfillment.orderId } });
  if (all.length && all.every(f => f.status === 'DELIVERED')) {
    await prisma.order.update({ where: { id: fulfillment.orderId }, data: { status: 'FULFILLED' } });
  } else if (all.some(f => f.status === 'SHIPPED' || f.status === 'DELIVERED')) {
    await prisma.order.update({ where: { id: fulfillment.orderId }, data: { status: 'PARTIALLY_FULFILLED' } });
  }
  res.json(updated);
}));
