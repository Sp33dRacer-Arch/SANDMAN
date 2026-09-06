import express, { Router } from 'express';
import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { getStripe } from '../../services/stripe.service';
import { finalizePaidOrder } from '../../services/payment-finalization.service';
import { paypalWebhookConfigured, verifyPayPalWebhookSignature } from '../../services/paypal.service';

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

webhooksRouter.post('/paypal', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  if (!paypalWebhookConfigured()) throw new HttpError(503, 'PayPal webhook is not configured');
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'PayPal webhook body must be raw JSON');

  await verifyPayPalWebhookSignature(req.body, req.headers);

  let event: any;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid PayPal webhook JSON');
  }
  if (!event?.id || !event?.event_type) throw new HttpError(400, 'Invalid PayPal webhook event');

  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_externalId: { provider: 'paypal', externalId: String(event.id) } },
  });
  if (existing?.processed) return res.json({ received: true, duplicate: true });

  await prisma.webhookEvent.upsert({
    where: { provider_externalId: { provider: 'paypal', externalId: String(event.id) } },
    create: {
      provider: 'paypal',
      externalId: String(event.id),
      eventType: String(event.event_type),
      payload: event as Prisma.InputJsonValue,
    },
    update: { payload: event as Prisma.InputJsonValue, eventType: String(event.event_type) },
  });

  try {
    const resource = event.resource ?? {};
    const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id
      || (String(event.event_type).startsWith('CHECKOUT.ORDER.') ? resource?.id : undefined)
      || (event.event_type === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED' ? resource?.id : undefined);

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && paypalOrderId) {
      const order = await prisma.order.findUnique({ where: { paypalOrderId: String(paypalOrderId) } });
      if (order) {
        const expected = (order.totalCents / 100).toFixed(2);
        const amount = resource?.amount;
        if (order.paymentProvider !== 'paypal'
          || resource?.status !== 'COMPLETED'
          || (resource?.custom_id && resource.custom_id !== order.id)
          || (resource?.invoice_id && resource.invoice_id !== order.orderNumber)
          || !amount
          || String(amount.value) !== expected
          || String(amount.currency_code).toUpperCase() !== order.currency.toUpperCase()) {
          throw new HttpError(409, 'PayPal webhook payment does not match the SANDMAN order');
        }
        if (resource?.id) {
          await prisma.order.update({ where: { id: order.id }, data: { paypalCaptureId: String(resource.id) } });
        }
        await finalizePaidOrder({ orderId: order.id, provider: 'paypal', message: 'PayPal webhook confirmed payment capture' });
      }
    }

    if (['PAYMENT.CAPTURE.DENIED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED', 'CHECKOUT.ORDER.DECLINED'].includes(String(event.event_type)) && paypalOrderId) {
      const order = await prisma.order.findUnique({ where: { paypalOrderId: String(paypalOrderId) } });
      if (order && order.paymentProvider === 'paypal') {
        const failed = await prisma.order.updateMany({
          where: { id: order.id, paymentStatus: { in: ['PENDING', 'AUTHORIZED'] } },
          data: { paymentStatus: 'FAILED' },
        });
        if (failed.count === 1) {
          await prisma.orderEvent.create({
            data: {
              orderId: order.id,
              type: 'PAYMENT_FAILED',
              message: `PayPal reported ${String(event.event_type).replaceAll('.', ' ').toLowerCase()}`.slice(0, 500),
            },
          });
        }
      }
    }

    if (event.event_type === 'PAYMENT.CAPTURE.PENDING' && paypalOrderId) {
      const order = await prisma.order.findUnique({ where: { paypalOrderId: String(paypalOrderId) } });
      if (order && order.paymentProvider === 'paypal' && order.paymentStatus === 'PENDING') {
        await prisma.orderEvent.create({
          data: { orderId: order.id, type: 'PAYMENT_PENDING', message: 'PayPal capture is pending settlement; fulfillment remains on hold.' },
        });
      }
    }

    await prisma.webhookEvent.update({
      where: { provider_externalId: { provider: 'paypal', externalId: String(event.id) } },
      data: { processed: true, processedAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { provider_externalId: { provider: 'paypal', externalId: String(event.id) } },
      data: { errorMessage: error instanceof Error ? error.message : 'PayPal webhook processing failed' },
    });
    throw error;
  }

  res.json({ received: true });
}));
