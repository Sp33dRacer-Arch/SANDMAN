import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth } from '../../middleware/auth';
import { env } from '../../config/env';
import { dollarsToCents, calculateOrderTotals } from '../../lib/money';
import { createOrderNumber } from '../../lib/order-number';
import { chooseSupplierForProduct } from '../../services/supplier-routing';
import { getStripe } from '../../services/stripe.service';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const addressSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  company: z.string().max(120).optional(),
  line1: z.string().min(2).max(160),
  line2: z.string().max(160).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  postalCode: z.string().min(2).max(20),
  country: z.string().length(2).transform(v => v.toUpperCase()),
  phone: z.string().max(40).optional(),
});

async function loadCheckoutCart(userId: string) {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          product: {
            include: {
              fitments: { select: { vehicleVariantId: true } },
              supplierLinks: { where: { active: true }, include: { supplier: true } },
            },
          },
        },
      },
    },
  });
  if (!cart?.items.length) throw new HttpError(400, 'Cart is empty');

  for (const item of cart.items) {
    if (item.product.status !== 'ACTIVE') throw new HttpError(409, `${item.product.name} is no longer available`);
    if (item.product.sourceType === 'DROPSHIP' && !item.product.supplierLinks.length) {
      throw new HttpError(409, `${item.product.name} is temporarily unavailable`);
    }
    if (item.product.sourceType === 'MARKETPLACE' && item.quantity > (item.product.stockQuantity ?? 0)) {
      throw new HttpError(409, `${item.product.name} no longer has enough seller stock`);
    }
    if (item.product.requiresFitment && !item.product.isUniversal) {
      if (!item.fitmentVehicleVariantId) throw new HttpError(409, `Vehicle fitment is missing for ${item.product.name}`);
      if (!item.product.fitments.some(f => f.vehicleVariantId === item.fitmentVehicleVariantId)) {
        throw new HttpError(409, `${item.product.name} is not compatible with the selected vehicle`);
      }
    }
  }
  return cart;
}

function totalsForCart(cart: Awaited<ReturnType<typeof loadCheckoutCart>>) {
  const subtotalCents = cart.items.reduce((sum, item) => sum + item.product.priceCents * item.quantity, 0);
  const dropshipSubtotalCents = cart.items
    .filter(item => item.product.sourceType === 'DROPSHIP')
    .reduce((sum, item) => sum + item.product.priceCents * item.quantity, 0);
  const sellerShippingCents = cart.items
    .filter(item => item.product.sourceType === 'MARKETPLACE')
    .reduce((sum, item) => sum + item.product.sellerShippingCents * item.quantity, 0);

  const base = calculateOrderTotals({
    subtotalCents,
    freeShippingThresholdCents: dollarsToCents(env.FREE_SHIPPING_THRESHOLD),
    flatShippingCents: dropshipSubtotalCents > 0 ? dollarsToCents(env.FLAT_SHIPPING_RATE) : 0,
    taxRate: env.DEFAULT_TAX_RATE,
  });
  const shippingCents = base.shippingCents + sellerShippingCents;
  return { ...base, shippingCents, totalCents: base.totalCents + sellerShippingCents };
}

ordersRouter.post('/quote', asyncHandler(async (req, res) => {
  addressSchema.parse(req.body.shippingAddress);
  const cart = await loadCheckoutCart(req.auth!.userId);
  res.json({ currency: env.CURRENCY, ...totalsForCart(cart) });
}));

ordersRouter.post('/checkout', asyncHandler(async (req, res) => {
  const body = z.object({
    shippingAddress: addressSchema,
    billingAddress: addressSchema.optional(),
    customerNote: z.string().max(1000).optional(),
  }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');

  const cart = await loadCheckoutCart(user.id);
  const totals = totalsForCart(cart);

  const assignments = await Promise.all(cart.items.map(async item => ({
    item,
    link: item.product.sourceType === 'DROPSHIP'
      ? await chooseSupplierForProduct(item.productId, item.quantity)
      : null,
  })));

  const order = await prisma.$transaction(async tx => {
    const created = await tx.order.create({
      data: {
        orderNumber: createOrderNumber(),
        userId: user.id,
        email: user.email,
        currency: env.CURRENCY,
        ...totals,
        shippingAddress: body.shippingAddress as Prisma.InputJsonValue,
        billingAddress: (body.billingAddress ?? body.shippingAddress) as Prisma.InputJsonValue,
        customerNote: body.customerNote,
        items: {
          create: assignments.map(({ item, link }) => ({
            productId: item.productId,
            sku: item.product.sku,
            name: item.product.name,
            quantity: item.quantity,
            unitPriceCents: item.product.priceCents,
            totalPriceCents: item.product.priceCents * item.quantity,
            sourceType: item.product.sourceType,
            sellerId: item.product.sellerId,
            supplierId: link?.supplierId,
            supplierProductId: link?.supplierProductId,
            supplierCostCents: link ? (link.costCents + link.shippingCents) * item.quantity : undefined,
            fitmentSnapshot: item.fitmentVehicleVariantId
              ? ({ vehicleVariantId: item.fitmentVehicleVariantId } as Prisma.InputJsonValue)
              : undefined,
          })),
        },
        events: { create: { type: 'ORDER_CREATED', message: 'Checkout order created' } },
      },
      include: { items: true },
    });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return created;
  });

  const stripe = getStripe();
  if (!stripe) {
    return res.status(201).json({
      order,
      payment: { provider: 'not_configured', clientSecret: null },
      warning: 'STRIPE_SECRET_KEY is not configured. The order remains PENDING_PAYMENT.',
    });
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: order.totalCents,
    currency: order.currency.toLowerCase(),
    receipt_email: order.email,
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
    automatic_payment_methods: { enabled: true },
  });
  await prisma.order.update({ where: { id: order.id }, data: { stripePaymentIntentId: paymentIntent.id } });

  res.status(201).json({
    order: { ...order, stripePaymentIntentId: paymentIntent.id },
    payment: { provider: 'stripe', clientSecret: paymentIntent.client_secret },
  });
}));

ordersRouter.get('/', asyncHandler(async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.auth!.userId },
    include: { items: true, fulfillments: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
}));

ordersRouter.get('/:orderNumber', asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { orderNumber: routeParam(req.params.orderNumber, 'orderNumber'), userId: req.auth!.userId },
    include: { items: true, fulfillments: true, events: { orderBy: { createdAt: 'desc' } } },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  res.json(order);
}));
