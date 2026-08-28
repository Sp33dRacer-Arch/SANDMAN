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
import { createPayPalOrder, capturePayPalOrder, paypalConfigured } from '../../services/paypal.service';
import { finalizePaidOrder } from '../../services/payment-finalization.service';
import { rollbackUninitializedCheckout } from '../../services/order-lifecycle.service';

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
              seller: { select: { id: true, stripeConnectAccountId: true, stripeConnectPayoutsEnabled: true } },
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
    if (item.product.sourceType === 'MARKETPLACE' && (!item.product.seller?.stripeConnectAccountId || !item.product.seller.stripeConnectPayoutsEnabled)) {
      throw new HttpError(409, `${item.product.name} is temporarily unavailable while the seller completes payout verification`);
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
    paymentProvider: z.enum(['stripe', 'paypal', 'bank_transfer']).default('stripe'),
  }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');

  if (body.paymentProvider === 'stripe' && (!getStripe() || !env.STRIPE_PUBLISHABLE_KEY)) throw new HttpError(503, 'Stripe is not fully configured');
  if (body.paymentProvider === 'paypal' && !paypalConfigured()) throw new HttpError(503, 'PayPal is not configured');
  if (body.paymentProvider === 'bank_transfer' && !env.BANK_TRANSFER_INSTRUCTIONS) throw new HttpError(503, 'Bank transfer is not configured');

  const cart = await loadCheckoutCart(user.id);
  const totals = totalsForCart(cart);

  const hasMarketplaceItems = cart.items.some(item => item.product.sourceType === 'MARKETPLACE');
  if (hasMarketplaceItems && body.paymentProvider !== 'stripe') {
    throw new HttpError(400, 'Marketplace carts require Stripe so seller payouts can be split securely through Stripe Connect');
  }

  const assignments = await Promise.all(cart.items.map(async item => ({
    item,
    link: item.product.sourceType === 'DROPSHIP'
      ? await chooseSupplierForProduct(item.productId, item.quantity)
      : null,
  })));

  const order = await prisma.$transaction(async tx => {
    // Reserve seller-owned stock atomically before the order is exposed to a payment provider.
    for (const { item } of assignments) {
      if (item.product.sourceType !== 'MARKETPLACE') continue;
      const reserved = await tx.product.updateMany({
        where: {
          id: item.productId,
          sourceType: 'MARKETPLACE',
          status: 'ACTIVE',
          stockQuantity: { gte: item.quantity },
        },
        data: { stockQuantity: { decrement: item.quantity } },
      });
      if (reserved.count !== 1) throw new HttpError(409, `${item.product.name} was just purchased by another customer`);
    }

    return tx.order.create({
      data: {
        orderNumber: createOrderNumber(),
        userId: user.id,
        email: user.email,
        currency: env.CURRENCY,
        ...totals,
        shippingAddress: body.shippingAddress as Prisma.InputJsonValue,
        billingAddress: (body.billingAddress ?? body.shippingAddress) as Prisma.InputJsonValue,
        customerNote: body.customerNote,
        paymentProvider: body.paymentProvider,
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
            sellerShippingCents: item.product.sourceType === 'MARKETPLACE' ? item.product.sellerShippingCents * item.quantity : 0,
            platformFeeCents: item.product.sourceType === 'MARKETPLACE'
              ? Math.floor((item.product.priceCents * item.quantity) * (env.MARKETPLACE_COMMISSION_PERCENT / 100))
              : 0,
            sellerPayoutCents: item.product.sourceType === 'MARKETPLACE'
              ? (item.product.priceCents * item.quantity)
                - Math.floor((item.product.priceCents * item.quantity) * (env.MARKETPLACE_COMMISSION_PERCENT / 100))
                + (item.product.sellerShippingCents * item.quantity)
              : undefined,
            supplierId: link?.supplierId,
            supplierProductId: link?.supplierProductId,
            supplierCostCents: link ? (link.costCents + link.shippingCents) * item.quantity : undefined,
            fitmentSnapshot: item.fitmentVehicleVariantId
              ? ({ vehicleVariantId: item.fitmentVehicleVariantId } as Prisma.InputJsonValue)
              : undefined,
          })),
        },
        events: { create: { type: 'ORDER_CREATED', message: 'Checkout order created and marketplace stock reserved' } },
      },
      include: { items: true },
    });
  });

  try {
    if (body.paymentProvider === 'bank_transfer') {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      return res.status(201).json({
        order,
        payment: { provider: 'bank_transfer', status: 'pending', instructions: env.BANK_TRANSFER_INSTRUCTIONS },
      });
    }

    if (body.paymentProvider === 'paypal') {
      const paypalOrder = await createPayPalOrder({
        localOrderId: order.id,
        orderNumber: order.orderNumber,
        amountCents: order.totalCents,
        currency: order.currency,
      });
      await prisma.$transaction([
        prisma.order.update({ where: { id: order.id }, data: { paypalOrderId: paypalOrder.id } }),
        prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
      ]);
      return res.status(201).json({
        order: { ...order, paypalOrderId: paypalOrder.id },
        payment: { provider: 'paypal', paypalOrderId: paypalOrder.id },
      });
    }

    const stripe = getStripe();
    if (!stripe || !env.STRIPE_PUBLISHABLE_KEY) throw new HttpError(503, 'Stripe is not fully configured');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: order.totalCents,
      currency: order.currency.toLowerCase(),
      receipt_email: order.email,
      metadata: { orderId: order.id, orderNumber: order.orderNumber },
      automatic_payment_methods: { enabled: true },
      transfer_group: `ORDER_${order.id}`,
    }, {
      idempotencyKey: `sandman-checkout-${order.id}`,
    });

    await prisma.$transaction([
      prisma.order.update({ where: { id: order.id }, data: { stripePaymentIntentId: paymentIntent.id } }),
      prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
    ]);

    return res.status(201).json({
      order: { ...order, stripePaymentIntentId: paymentIntent.id },
      payment: { provider: 'stripe', clientSecret: paymentIntent.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY },
    });
  } catch (error) {
    // Payment initialization never reached the customer, so restore the seller
    // stock and keep their cart intact for a retry.
    await rollbackUninitializedCheckout(order.id).catch(() => undefined);
    throw error;
  }
}));

ordersRouter.post('/:orderNumber/paypal/capture', asyncHandler(async (req, res) => {
  const orderNumber = routeParam(req.params.orderNumber, 'orderNumber');
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: req.auth!.userId },
  });
  if (!order) throw new HttpError(404, 'Order not found');
  if (!order.paypalOrderId) throw new HttpError(409, 'This order does not have a PayPal payment');
  if (order.paymentStatus === 'PAID') return res.json({ success: true, alreadyPaid: true, order });

  const capture = await capturePayPalOrder(order.paypalOrderId);
  if (capture.status !== 'COMPLETED') throw new HttpError(409, `PayPal payment is ${capture.status || 'not complete'}`);

  const unit = capture.purchase_units?.[0];
  const captureAmount = unit?.payments?.captures?.[0]?.amount;
  const expected = (order.totalCents / 100).toFixed(2);
  if (!unit || unit.custom_id !== order.id || unit.invoice_id !== order.orderNumber) {
    throw new HttpError(409, 'PayPal order identity does not match the SANDMAN order');
  }
  if (!captureAmount || String(captureAmount.value) !== expected || String(captureAmount.currency_code).toUpperCase() !== order.currency.toUpperCase()) {
    throw new HttpError(409, 'PayPal captured amount does not match the SANDMAN order');
  }

  await finalizePaidOrder({ orderId: order.id, provider: 'paypal', message: 'PayPal payment captured successfully' });
  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true, fulfillments: true } });
  res.json({ success: true, order: updated });
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
