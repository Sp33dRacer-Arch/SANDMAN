import { Router } from 'express';
import { env } from '../../config/env';
import { paypalConfigured } from '../../services/paypal.service';

export const paymentsRouter = Router();

paymentsRouter.get('/config', (_req, res) => {
  res.json({
    currency: env.CURRENCY,
    stripe: {
      enabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY),
      publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
      description: 'Eligible cards, wallets, bank methods, BNPL and local payment methods are shown dynamically by Stripe.',
    },
    paypal: {
      enabled: paypalConfigured(),
      clientId: env.PAYPAL_CLIENT_ID || null,
      mode: env.PAYPAL_MODE,
    },
    bankTransfer: {
      enabled: Boolean(env.BANK_TRANSFER_INSTRUCTIONS),
      instructions: env.BANK_TRANSFER_INSTRUCTIONS || null,
      manualVerification: true,
    },
    marketplace: {
      commissionPercent: env.MARKETPLACE_COMMISSION_PERCENT,
      payoutProvider: 'Stripe Connect',
    },
  });
});
