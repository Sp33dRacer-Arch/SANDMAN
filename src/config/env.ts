import 'dotenv/config';
import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().min(1).optional());

const optionalUrlString = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().url().optional());

const optionalMin24String = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().min(24).optional());

const booleanFromEnv = z.preprocess(value => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:4000'),
  API_URL: z.string().url().default('http://localhost:4000'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('2h'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  CURRENCY: z.string().length(3).default('USD'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  BANK_TRANSFER_INSTRUCTIONS: z.string().max(2000).optional(),

  // Optional signed browser uploads. Configure all three to enable image-file uploads.
  CLOUDINARY_CLOUD_NAME: optionalNonEmptyString,
  CLOUDINARY_API_KEY: optionalNonEmptyString,
  CLOUDINARY_API_SECRET: optionalNonEmptyString,

  EMAIL_DELIVERY_WEBHOOK_URL: optionalUrlString,
  EMAIL_DELIVERY_WEBHOOK_SECRET: z.string().optional(),

  MARKETPLACE_COMMISSION_PERCENT: z.coerce.number().min(0).max(50).default(10),
  MARKETPLACE_PAYOUT_DELAY_DAYS: z.coerce.number().int().min(0).max(30).default(7),

  DEFAULT_SUPPLIER: z.string().default('mock'),
  CJ_API_KEY: z.string().optional(),
  CJ_BASE_URL: z.string().url().default('https://developers.cjdropshipping.com/api2.0/v1'),
  SYNCEE_ORDERS_URL: z.string().url().default('https://syncee.com'),
  SYNCEE_MODE: z.enum(['manual']).default('manual'),
  SUPPLIER_FEED_SECRET: optionalMin24String,
  AUTO_PRICE_SUPPLIER_FEEDS: booleanFromEnv.default(false),
  CHECKOUT_RESERVATION_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  BANK_TRANSFER_RESERVATION_HOURS: z.coerce.number().int().min(1).max(168).default(48),

  FREE_SHIPPING_THRESHOLD: z.coerce.number().nonnegative().default(250),
  FLAT_SHIPPING_RATE: z.coerce.number().nonnegative().default(18),
  DEFAULT_TAX_RATE: z.coerce.number().min(0).max(1).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
