import Stripe from 'stripe';
import { env } from '../config/env';

let stripe: Stripe | null = null;

export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) return null;
  stripe ??= new Stripe(env.STRIPE_SECRET_KEY);
  return stripe;
}
