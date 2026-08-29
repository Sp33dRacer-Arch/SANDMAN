import express, { Router } from 'express';
import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { getStripe } from '../../services/stripe.service';
import { finalizePaidOrder } from '../../services/payment-finalization.service';

export const webhooksRouter = Router();

webhooksRouter.post('/stripe', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhook is not configured');

  const signature = req.header('stripe-signature');
  if (!signature) throw new HttpError(400, 'Missing Stripe signature');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw new HttpError(400, 'Invalid Stripe webhook signature', error instanceof Error ? error.message : undefined);
  }

  const existing = await prisma.webhookEvent.findUnique({ where: { provider_externalId: { provider: 'stripe', externalId: event.id } } });
  if (existing?.processed) return res.json({ received: true, duplicate: true });

  await prisma.webhookEvent.upsert({
    where: { provider_externalId: { provider: 'stripe', externalId: event.id } },
    create: { provider: 'stripe', externalId: event.id, eventType: event.type, payload: event as unknown as Prisma.InputJsonValue },
    update: { payload: event as unknown as Prisma.InputJsonValue },
  });

  try {
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId = intent.metadata.orderId;
      if (orderId) {
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order
          || order.stripePaymentIntentId !== intent.id
          || order.paymentProvider !== 'stripe'
          || order.totalCents !== intent.amount
          || order.currency.toLowerCase() !== intent.currency.toLowerCase()) {
          throw new HttpError(409, 'Stripe payment does not match the SANDMAN order');
        }
        await finalizePaidOrder({ orderId, provider: 'stripe', message: 'Stripe payment captured successfully' });
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId = intent.metadata.orderId;
      if (orderId) {
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (order?.stripePaymentIntentId === intent.id
          && order.status === 'PENDING_PAYMENT'
          && !order.marketplaceStockReleasedAt
          && ['PENDING', 'AUTHORIZED', 'FAILED'].includes(order.paymentStatus)) {
          await prisma.order.updateMany({
            where: {
              id: orderId,
              status: 'PENDING_PAYMENT',
              marketplaceStockReleasedAt: null,
              paymentStatus: { in: ['PENDING', 'AUTHORIZED', 'FAILED'] },
            },
            data: { paymentStatus: 'FAILED' },
          });
          await prisma.orderEvent.create({
            data: {
              orderId,
              type: 'PAYMENT_FAILED',
              message: intent.last_payment_error?.message?.slice(0, 500) || 'Stripe payment attempt failed; customer may retry',
            },
          });
        }
      }
    }

    await prisma.webhookEvent.update({
      where: { provider_externalId: { provider: 'stripe', externalId: event.id } },
      data: { processed: true, processedAt: new Date() },
    });
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { provider_externalId: { provider: 'stripe', externalId: event.id } },
      data: { errorMessage: error instanceof Error ? error.message : 'Webhook processing failed' },
    });
    throw error;
  }

  res.json({ received: true });
}));
