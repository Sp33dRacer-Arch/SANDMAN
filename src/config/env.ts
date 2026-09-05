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

const optionalMin32String = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().min(32).optional());

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
  // Keep TOTP encryption independent from JWT rotation in production.
  TOTP_ENCRYPTION_KEY: optionalMin32String,
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
  RESEND_API_KEY: optionalNonEmptyString,
  EMAIL_FROM: z.string().email().default('security@sandman.local'),
  SMS_DELIVERY_WEBHOOK_URL: optionalUrlString,
  SMS_DELIVERY_WEBHOOK_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: optionalNonEmptyString,
  TWILIO_AUTH_TOKEN: optionalNonEmptyString,
  TWILIO_FROM_NUMBER: optionalNonEmptyString,
  CONTENT_MODERATION_WEBHOOK_URL: optionalUrlString,
  CONTENT_MODERATION_WEBHOOK_SECRET: z.string().optional(),
  REQUIRE_IMAGE_MODERATION: booleanFromEnv.default(false),

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

  // V2.5 global-commerce fallbacks are retained only for legacy/internal tools.
  // Customer checkout itself fails closed unless a CommerceRegion + shipping/tax
  // configuration exists for the destination.
  FREE_SHIPPING_THRESHOLD: z.coerce.number().nonnegative().default(250),
  FLAT_SHIPPING_RATE: z.coerce.number().nonnegative().default(18),
  DEFAULT_TAX_RATE: z.coerce.number().min(0).max(1).default(0),

  DEFAULT_LOCALE: z.string().min(2).max(30).default('en-US'),
  CARRIER_RATE_WEBHOOK_URL: optionalUrlString,
  CARRIER_RATE_WEBHOOK_SECRET: optionalNonEmptyString,
  DUTY_CALCULATION_WEBHOOK_URL: optionalUrlString,
  DUTY_CALCULATION_WEBHOOK_SECRET: optionalNonEmptyString,

  ERROR_MONITORING_WEBHOOK_URL: optionalUrlString,
  ERROR_MONITORING_WEBHOOK_SECRET: optionalNonEmptyString,
  UPTIME_MONITOR_URL: optionalUrlString,

  DB_STORAGE_ALERT_THRESHOLD_MB: z.coerce.number().positive().optional(),
  DB_STORAGE_ALERT_WEBHOOK_URL: optionalUrlString,
  READ_REPLICA_DATABASE_URL: optionalNonEmptyString,

  ANALYTICS_WAREHOUSE_URL: optionalUrlString,
  ANALYTICS_WAREHOUSE_SECRET: optionalNonEmptyString,
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
  MARKETING_EVENT_WEBHOOK_URL: optionalUrlString,
  MARKETING_EVENT_WEBHOOK_SECRET: optionalNonEmptyString,

  FX_RATE_PROVIDER_URL: optionalUrlString,
  FX_RATE_PROVIDER_API_KEY: optionalNonEmptyString,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
