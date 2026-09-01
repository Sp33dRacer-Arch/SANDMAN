import Stripe from 'stripe';
import { env } from '../config/env';

let stripe: Stripe | null = null;

export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) return null;
  stripe ??= new Stripe(env.STRIPE_SECRET_KEY);
  return stripe;
}

// SANDMAN uses platform charges + separate Transfers for marketplace payouts.
// New connected accounts therefore use Stripe Accounts v2 with the recipient
// configuration. The rest of the existing payment/refund/transfer integration
// can continue using stripe-node v1 endpoints while the migration is staged.
const STRIPE_ACCOUNT_CREATE_V2_VERSION = '2026-08-26.preview';
const STRIPE_ACCOUNT_LINK_V2_VERSION = '2026-08-26.dahlia';

interface StripeV2ErrorPayload {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
}

interface StripeV2AccountResponse {
  id: string;
  object?: string;
}

interface StripeV2AccountLinkResponse {
  url: string;
  account?: string;
  object?: string;
  expires_at?: string;
}

export class StripeV2RequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'StripeV2RequestError';
    this.status = status;
    this.code = code;
  }
}

async function stripeV2Post<T>(path: string, body: unknown, apiVersion: string, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeV2RequestError('Stripe Connect is not configured', 503);
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Stripe-Version': apiVersion,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({})) as T & StripeV2ErrorPayload;
  if (!response.ok) {
    const message = payload.error?.message || `Stripe Connect request failed (${response.status})`;
    throw new StripeV2RequestError(message, response.status, payload.error?.code);
  }
  return payload;
}

export async function createMarketplaceRecipientAccount(input: {
  userId: string;
  email: string;
  displayName: string;
  country: string;
}) {
  const country = input.country.trim().toLowerCase();
  const result = await stripeV2Post<StripeV2AccountResponse>('/v2/core/accounts', {
    contact_email: input.email,
    display_name: input.displayName,
    defaults: {
      responsibilities: {
        fees_collector: 'application',
        losses_collector: 'application',
      },
    },
    dashboard: 'express',
    identity: { country },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: { requested: true },
          },
        },
      },
    },
    include: ['configuration.recipient', 'identity', 'requirements'],
  }, STRIPE_ACCOUNT_CREATE_V2_VERSION, `sandman-connect-account-${input.userId}`);

  if (!result.id?.startsWith('acct_')) throw new StripeV2RequestError('Stripe returned an invalid connected account', 502);
  return result;
}

export async function createMarketplaceRecipientOnboardingLink(input: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}) {
  const result = await stripeV2Post<StripeV2AccountLinkResponse>('/v2/core/account_links', {
    account: input.accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        collection_options: { fields: 'eventually_due', future_requirements: 'include' },
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
      },
    },
  }, STRIPE_ACCOUNT_LINK_V2_VERSION);

  if (!result.url?.startsWith('https://')) throw new StripeV2RequestError('Stripe did not return a secure onboarding URL', 502);
  return result;
}
