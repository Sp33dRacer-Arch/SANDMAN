import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
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
import { v2Router } from './modules/v2/v2.routes';
import { uploadsRouter } from './modules/uploads/uploads.routes';
import { socialRouter } from './modules/social/social.routes';
import { trustRouter, adminTrustRouter } from './modules/trust/trust.routes';
import { prisma } from './lib/prisma';
import { asyncHandler } from './lib/async-handler';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com', 'https://www.paypal.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://*.stripe.com', 'https://www.paypal.com', 'https://*.paypal.com', 'https://api.cloudinary.com'],
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
const registerLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const recoveryLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const verificationLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
const twoFactorLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/forgot-password', recoveryLimiter);
app.use('/api/auth/reset-password', recoveryLimiter);
app.use('/api/auth/email-verification', verificationLimiter);
app.use('/api/auth/phone-verification', verificationLimiter);
app.use('/api/auth/email-change', verificationLimiter);
app.use('/api/auth/account', recoveryLimiter);
app.use('/api/security/2fa', twoFactorLimiter);

const adminUiDir = path.join(process.cwd(), 'public', 'admin');
const storeUiDir = path.join(process.cwd(), 'public', 'store');
app.use('/admin', express.static(adminUiDir, { index: 'index.html' }));
app.get('/admin', (_req, res) => res.sendFile(path.join(adminUiDir, 'index.html')));
app.use('/store', express.static(storeUiDir, { index: 'index.html' }));
app.use('/assets', express.static(path.join(storeUiDir, 'assets')));

app.get('/api', (_req, res) => res.json({
  name: 'SANDMAN',
  description: 'Automotive parts marketplace, builds, fitment, dropshipping and seller platform',
  version: '2.4.1',
  health: '/api/health',
  admin: '/admin',
  storefront: '/',
}));

const storefrontTemplate = fs.readFileSync(path.join(storeUiDir, 'index.html'), 'utf8');
const htmlEsc = (value: string) => value.replace(/[&<>\"']/g, char => {
  if (char === '&') return '&amp;';
  if (char === '<') return '&lt;';
  if (char === '>') return '&gt;';
  if (char === '\"') return '&quot;';
  return '&#39;';
});
function storefrontHtml(meta?: { title?: string; description?: string; canonical?: string; image?: string | null }) {
  const title = meta?.title ?? 'SANDMAN — Automotive Parts Marketplace';
  const description = meta?.description ?? 'Find automotive parts by vehicle, engine code, OEM number or SKU. Verified fitment, supplier stock, marketplace sellers and builds.';
  const canonical = meta?.canonical ?? `${env.APP_URL.replace(/\/$/, '')}/`;
  const image = meta?.image ?? `${env.APP_URL.replace(/\/$/, '')}/assets/sandman-logo.webp`;
  return storefrontTemplate
    .replace(/<title>[^<]*<\/title>/, `<title>${htmlEsc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${htmlEsc(description)}" />`)
    .replace('</head>', `<link rel="canonical" href="${htmlEsc(canonical)}" /><meta property="og:title" content="${htmlEsc(title)}" /><meta property="og:description" content="${htmlEsc(description)}" /><meta property="og:url" content="${htmlEsc(canonical)}" /><meta property="og:type" content="website" /><meta property="og:image" content="${htmlEsc(image)}" /><meta name="twitter:card" content="summary_large_image" /></head>`);
}
const sendStorefront = (res: express.Response, meta?: Parameters<typeof storefrontHtml>[0]) => res.type('html').send(storefrontHtml(meta));

app.get('/', (_req, res) => sendStorefront(res));
app.get('/products/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug ?? '');
  const product = await prisma.product.findFirst({
    where: { slug, status: 'ACTIVE' },
    select: { name: true, shortDesc: true, description: true, brand: true, seoTitle: true, seoDescription: true, images: { orderBy: { position: 'asc' }, take: 1 } },
  });
  if (!product) {
    res.status(404);
    return sendStorefront(res, { title: 'Product not found — SANDMAN', description: 'This SANDMAN product is unavailable.', canonical: `${env.APP_URL.replace(/\/$/, '')}/products/${encodeURIComponent(slug)}` });
  }
  return sendStorefront(res, {
    title: product.seoTitle || `${product.name}${product.brand ? ` | ${product.brand}` : ''} — SANDMAN`,
    description: product.seoDescription || product.shortDesc || product.description.slice(0, 155),
    canonical: `${env.APP_URL.replace(/\/$/, '')}/products/${encodeURIComponent(slug)}`,
    image: product.images[0]?.url ?? null,
  });
}));

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /account\nDisallow: /checkout\nDisallow: /orders\nDisallow: /seller$\nDisallow: /garage\nDisallow: /messages\nDisallow: /wishlist\nDisallow: /notifications\nDisallow: /returns-center\nSitemap: ${env.APP_URL.replace(/\/$/, '')}/sitemap.xml\n`);
});
let sitemapCache: { expiresAt: number; xml: string } | null = null;
app.get('/sitemap.xml', asyncHandler(async (_req, res) => {
  if (sitemapCache && sitemapCache.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=900');
    return res.type('application/xml').send(sitemapCache.xml);
  }
  // A sitemap file may contain at most 50,000 URLs. Leave room for the static
  // storefront routes below instead of accidentally producing an invalid file.
  const products = await prisma.product.findMany({ where: { status: 'ACTIVE' }, select: { slug: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 49_980 });
  const base = env.APP_URL.replace(/\/$/, '');
  const staticPaths = ['/', '/shop', '/vehicles', '/build-advisor', '/marketplace', '/buyer-protection', '/shipping', '/returns', '/terms', '/privacy', '/about'];
  const urls = [
    ...staticPaths.map(pathname => `<url><loc>${htmlEsc(base + pathname)}</loc></url>`),
    ...products.map(product => `<url><loc>${htmlEsc(`${base}/products/${encodeURIComponent(product.slug)}`)}</loc><lastmod>${product.updatedAt.toISOString()}</lastmod></url>`),
  ].join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  sitemapCache = { expiresAt: Date.now() + 15 * 60 * 1000, xml };
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.type('application/xml').send(xml);
}));

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/products', productsRouter);
app.use('/api/uploads', uploadsRouter);
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
app.use('/api/social', socialRouter);
app.use('/api/trust', trustRouter);
app.use('/api/admin/trust', adminTrustRouter);
app.use('/api/admin/ops', opsRouter);
app.use('/api/supplier-feed', supplierFeedRouter);
app.use('/api/v2', v2Router);

// History-API storefront routes. Old #/ links remain supported by the browser router,
// but public/canonical URLs use normal paths so products and landing pages are crawlable.
const storefrontRoute = /^\/(?:shop|vehicles|vehicle-finder|build-advisor|advisor|requests|garage|builds(?:\/[^/]+)?|public-builds\/[^/]+|compare|wishlist|messages|sellers\/[^/]+|sell|seller|account|notifications|feed|profile\/[^/]+|checkout|orders\/[^/]+|returns-center|buyer-protection|shipping|returns|terms|privacy|about|verify-email|email-change|reset-password|marketplace)\/?$/;
app.get(storefrontRoute, (_req, res) => sendStorefront(res));

app.use(notFound);
app.use(errorHandler);
