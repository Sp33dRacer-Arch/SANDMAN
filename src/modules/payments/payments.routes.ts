import { Router } from 'express';
import { env } from '../../config/env';
import { paypalConfigured, paypalWebhookConfigured } from '../../services/paypal.service';

export const paymentsRouter = Router();

paymentsRouter.get('/config', (_req, res) => {
  res.json({
    currency: env.CURRENCY,
    primaryProvider: 'paypal',
    paypal: {
      enabled: paypalConfigured(),
      clientId: env.PAYPAL_CLIENT_ID || null,
      mode: env.PAYPAL_MODE,
      webhookReady: paypalWebhookConfigured(),
      description: 'Primary SANDMAN checkout. PayPal handles PayPal, Google Pay and Apple Pay eligibility while SANDMAN captures server-side with verified webhooks.',
      wallets: { googlePay: true, applePay: true, eligibilityCheckedInBrowser: true },
    },
    bankTransfer: {
      enabled: Boolean(env.BANK_TRANSFER_INSTRUCTIONS),
      instructions: env.BANK_TRANSFER_INSTRUCTIONS || null,
      manualVerification: true,
    },
    marketplace: {
      commissionPercent: env.MARKETPLACE_COMMISSION_PERCENT,
      checkoutEnabled: false,
      payoutProvider: null,
      note: 'Marketplace checkout is paused until a PayPal-compatible multiparty payout flow is approved and implemented.',
    },
  });
});
