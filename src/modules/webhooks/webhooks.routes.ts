import express, { Router } from 'express';
import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { getStripe } from '../../services/stripe.service';
import { submitPaidOrderToSuppliers } from '../../services/fulfillment.service';

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
        await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID', status: 'PAID' } });
        await prisma.orderEvent.create({ data: { orderId, type: 'PAYMENT_SUCCEEDED', message: 'Payment captured successfully' } });
        await submitPaidOrderToSuppliers(orderId);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId = intent.metadata.orderId;
      if (orderId) {
        await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'FAILED', status: 'FAILED' } });
        await prisma.orderEvent.create({ data: { orderId, type: 'PAYMENT_FAILED', message: 'Payment failed' } });
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
