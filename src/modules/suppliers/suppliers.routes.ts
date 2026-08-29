import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { supplierAdapterFor } from '../../services/supplier-registry';
import { submitPaidOrderToSuppliers } from '../../services/fulfillment.service';
import { recomputeOrderFulfillmentStatus } from '../../services/order-lifecycle.service';
import { createNotification } from '../../services/notification.service';
import { sendEmail } from '../../services/email.service';

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
    where: { id: routeParam(req.params.id, 'id') },
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

  await recomputeOrderFulfillmentStatus(fulfillment.orderId);
  if (status === 'SHIPPED' || status === 'DELIVERED') {
    const order = await prisma.order.findUnique({ where: { id: fulfillment.orderId }, select: { orderNumber: true, userId: true, email: true } });
    if (order?.userId) await createNotification({ userId: order.userId, type: 'SHIPPING', title: status === 'SHIPPED' ? 'Order shipped' : 'Order delivered', body: `Order ${order.orderNumber} is ${status.toLowerCase()}.`, link: `#/order/${order.orderNumber}` }).catch(() => undefined);
    if (order) await sendEmail({ to: order.email, subject: `SANDMAN order ${order.orderNumber}: ${status.toLowerCase()}`, text: `Your order ${order.orderNumber} is ${status.toLowerCase()}.`, type: 'SHIPPING' }).catch(() => undefined);
  }
  res.json(updated);
}));


suppliersRouter.patch('/fulfillments/:id/manual', asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']).optional(),
    trackingNumber: z.string().min(2).max(160).optional(),
    trackingUrl: z.string().url().optional(),
    carrier: z.string().min(2).max(100).optional(),
  }).parse(req.body);
  const fulfillment = await prisma.fulfillment.findUnique({ where: { id: routeParam(req.params.id, 'id') } });
  if (!fulfillment) throw new HttpError(404, 'Fulfillment not found');
  const status = body.status ?? (body.trackingNumber ? 'SHIPPED' : fulfillment.status);
  const updated = await prisma.fulfillment.update({
    where: { id: fulfillment.id },
    data: {
      status,
      trackingNumber: body.trackingNumber,
      trackingUrl: body.trackingUrl,
      carrier: body.carrier,
      shippedAt: status === 'SHIPPED' && !fulfillment.shippedAt ? new Date() : fulfillment.shippedAt,
      deliveredAt: status === 'DELIVERED' && !fulfillment.deliveredAt ? new Date() : fulfillment.deliveredAt,
    },
  });
  await prisma.orderEvent.create({
    data: { orderId: fulfillment.orderId, type: 'MANUAL_FULFILLMENT_UPDATE', message: `Fulfillment manually updated to ${status}` },
  });
  await recomputeOrderFulfillmentStatus(fulfillment.orderId);
  if (status === 'SHIPPED' || status === 'DELIVERED') {
    const order = await prisma.order.findUnique({ where: { id: fulfillment.orderId }, select: { orderNumber: true, userId: true, email: true } });
    if (order?.userId) await createNotification({ userId: order.userId, type: 'SHIPPING', title: status === 'SHIPPED' ? 'Order shipped' : 'Order delivered', body: `Order ${order.orderNumber} is ${status.toLowerCase()}.`, link: `#/order/${order.orderNumber}` }).catch(() => undefined);
    if (order) await sendEmail({ to: order.email, subject: `SANDMAN order ${order.orderNumber}: ${status.toLowerCase()}`, text: `Your order ${order.orderNumber} is ${status.toLowerCase()}.`, type: 'SHIPPING' }).catch(() => undefined);
  }
  res.json(updated);
}));

suppliersRouter.post('/fulfillments/:id/retry', asyncHandler(async (req, res) => {
  const fulfillment = await prisma.fulfillment.findUnique({
    where: { id: routeParam(req.params.id, 'id') },
    include: { order: true },
  });
  if (!fulfillment) throw new HttpError(404, 'Fulfillment not found');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(fulfillment.order.paymentStatus)) throw new HttpError(409, 'Order is not paid');
  const results = await submitPaidOrderToSuppliers(fulfillment.orderId, { retryFailed: true });
  res.json(results);
}));
