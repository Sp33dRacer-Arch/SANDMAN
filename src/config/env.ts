import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CURRENCY: z.string().length(3).default('USD'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  DEFAULT_SUPPLIER: z.string().default('mock'),
  CJ_API_KEY: z.string().optional(),
  CJ_BASE_URL: z.string().url().default('https://developers.cjdropshipping.com/api2.0/v1'),
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
