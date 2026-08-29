import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { env } from './config/env';
import { webhooksRouter } from './modules/webhooks/webhooks.routes';
import { authRouter } from './modules/auth/auth.routes';
import { vehiclesRouter } from './modules/vehicles/vehicles.routes';
import { productsRouter } from './modules/products/products.routes';
import { garageRouter } from './modules/garage/garage.routes';
import { cartRouter } from './modules/cart/cart.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { suppliersRouter } from './modules/suppliers/suppliers.routes';
import { healthRouter } from './modules/health/health.routes';
import { marketplaceRouter } from './modules/marketplace/marketplace.routes';
import { paymentsRouter } from './modules/payments/payments.routes';
import { errorHandler, notFound } from './middleware/error-handler';
import { experienceRouter } from './modules/experience/experience.routes';
import { reviewsRouter } from './modules/reviews/reviews.routes';
import { buildsRouter } from './modules/builds/builds.routes';
import { communityRouter } from './modules/community/community.routes';
import { supportRouter } from './modules/support/support.routes';
import { securityRouter } from './modules/security/security.routes';
import { opsRouter } from './modules/ops/ops.routes';
import { supplierFeedRouter } from './modules/supplier-feed/supplier-feed.routes';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com', 'https://www.paypal.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://*.stripe.com', 'https://www.paypal.com', 'https://*.paypal.com'],
      frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com', 'https://www.paypal.com', 'https://*.paypal.com'],
      fontSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(cors({ origin: env.APP_URL, credentials: true }));
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Stripe must receive the untouched request body, so mount webhooks before express.json().
app.use('/api/webhooks', webhooksRouter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }));

// Authentication endpoints need a much tighter ceiling than normal browsing.
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const recoveryLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/forgot-password', recoveryLimiter);
app.use('/api/auth/reset-password', recoveryLimiter);

const adminUiDir = path.join(process.cwd(), 'public', 'admin');
const storeUiDir = path.join(process.cwd(), 'public', 'store');
app.use('/admin', express.static(adminUiDir, { index: 'index.html' }));
app.get('/admin', (_req, res) => res.sendFile(path.join(adminUiDir, 'index.html')));
app.use('/store', express.static(storeUiDir, { index: 'index.html' }));
app.use('/assets', express.static(path.join(storeUiDir, 'assets')));

app.get('/api', (_req, res) => res.json({
  name: 'SANDMAN',
  description: 'Automotive parts marketplace, builds, fitment, dropshipping and seller platform',
  version: '1.4.2',
  health: '/api/health',
  admin: '/admin',
  storefront: '/',
}));

app.get('/', (_req, res) => res.sendFile(path.join(storeUiDir, 'index.html')));

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/products', productsRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/garage', garageRouter);
app.use('/api/cart', cartRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/suppliers', suppliersRouter);
app.use('/api/experience', experienceRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/builds', buildsRouter);
app.use('/api/community', communityRouter);
app.use('/api/support', supportRouter);
app.use('/api/security', securityRouter);
app.use('/api/admin/ops', opsRouter);
app.use('/api/supplier-feed', supplierFeedRouter);

app.use(notFound);
app.use(errorHandler);
