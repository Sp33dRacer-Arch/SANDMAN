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
import { customerIntelligenceRouter } from './modules/admin/customer-intelligence.routes';
import { readinessRouter } from './modules/admin/readiness.routes';
import { commerceRouter, adminCommerceRouter } from './modules/commerce/commerce.routes';
import { privacyRouter } from './modules/privacy/privacy.routes';
import { analyticsRouter, adminAnalyticsRouter } from './modules/analytics/analytics.routes';
import { adminVinyasaRouter, vinyasaIntegrationRouter } from './modules/vinyasa/vinyasa.routes';
import { prisma } from './lib/prisma';
import { asyncHandler } from './lib/async-handler';
import { buildProductSeo, safeJsonLd, websiteStructuredData } from './services/storefront-seo.service';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://www.paypal.com', 'https://pay.google.com', 'https://applepay.cdn-apple.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://www.paypal.com', 'https://*.paypal.com', 'https://pay.google.com', 'https://*.google.com', 'https://apple-pay-gateway.apple.com', 'https://api.cloudinary.com'],
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://*.paypal.com', 'https://pay.google.com'],
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

// PayPal/Apple require the exact merchant-domain association file to be served
// from this well-known path before Apple Pay can be enabled for a live domain.
const applePayAssociationFile = path.join(process.cwd(), 'public', 'apple-developer-merchantid-domain-association');
app.get('/.well-known/apple-developer-merchantid-domain-association', (_req, res) => {
  if (!fs.existsSync(applePayAssociationFile)) return res.status(404).end();
  res.type('application/octet-stream').sendFile(applePayAssociationFile);
});

app.get('/api', (_req, res) => res.json({
  name: 'SANDMAN',
  description: 'Automotive parts marketplace, builds, fitment, dropshipping and seller platform',
  version: '2.6.1',
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
type StorefrontMeta = {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string | null;
  imageAlt?: string;
  type?: 'website' | 'product';
  robots?: string;
  productPrice?: string;
  productCurrency?: string;
  availability?: 'in stock' | 'out of stock';
  jsonLd?: unknown[];
};
function storefrontHtml(meta?: StorefrontMeta) {
  const base = env.APP_URL.replace(/\/$/, '');
  const title = meta?.title ?? 'SANDMAN — Automotive Parts Marketplace';
  const description = meta?.description ?? 'Find automotive parts by vehicle, engine code, OEM number or SKU. Verified fitment, supplier stock, marketplace sellers and builds.';
  const canonical = meta?.canonical ?? `${base}/`;
  const image = meta?.image || `${base}/assets/sandman-logo.webp`;
  const imageAlt = meta?.imageAlt || title;
  const type = meta?.type ?? 'website';
  const robots = meta?.robots ?? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
  const jsonLd = [websiteStructuredData(base), ...(meta?.jsonLd ?? [])];
  const productTags = type === 'product'
    ? `${meta?.productPrice ? `<meta property="product:price:amount" content="${htmlEsc(meta.productPrice)}" />` : ''}${meta?.productCurrency ? `<meta property="product:price:currency" content="${htmlEsc(meta.productCurrency)}" />` : ''}${meta?.availability ? `<meta property="product:availability" content="${htmlEsc(meta.availability)}" />` : ''}`
    : '';
  const structuredData = jsonLd.map((data, index) => `<script type="application/ld+json"${index ? ' data-sandman-page-schema="1"' : ''}>${safeJsonLd(data)}</script>`).join('');
  return storefrontTemplate
    .replace(/<title>[^<]*<\/title>/, `<title>${htmlEsc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${htmlEsc(description)}" />`)
    .replace('</head>', `<link rel="canonical" href="${htmlEsc(canonical)}" /><meta name="robots" content="${htmlEsc(robots)}" /><meta property="og:site_name" content="SANDMAN" /><meta property="og:locale" content="en_US" /><meta property="og:title" content="${htmlEsc(title)}" /><meta property="og:description" content="${htmlEsc(description)}" /><meta property="og:url" content="${htmlEsc(canonical)}" /><meta property="og:type" content="${type}" /><meta property="og:image" content="${htmlEsc(image)}" /><meta property="og:image:alt" content="${htmlEsc(imageAlt)}" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${htmlEsc(title)}" /><meta name="twitter:description" content="${htmlEsc(description)}" /><meta name="twitter:image" content="${htmlEsc(image)}" />${productTags}${structuredData}</head>`);
}
const sendStorefront = (res: express.Response, meta?: StorefrontMeta) => res.type('html').send(storefrontHtml(meta));

app.get('/', (_req, res) => sendStorefront(res));
app.get('/products/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug ?? '');
  const product = await prisma.product.findFirst({
    where: { slug, status: 'ACTIVE' },
    select: {
      slug: true,
      name: true,
      sku: true,
      brand: true,
      manufacturerPn: true,
      description: true,
      shortDesc: true,
      seoTitle: true,
      seoDescription: true,
      priceCents: true,
      currency: true,
      condition: true,
      sourceType: true,
      stockQuantity: true,
      category: { select: { name: true, slug: true } },
      images: { orderBy: { position: 'asc' }, take: 8, select: { url: true, alt: true } },
      supplierLinks: { where: { active: true }, take: 8, select: { active: true, stock: true, availableStock: true } },
    },
  });
  if (!product) {
    res.status(404);
    return sendStorefront(res, {
      title: 'Product not found — SANDMAN',
      description: 'This SANDMAN product is unavailable.',
      canonical: `${env.APP_URL.replace(/\/$/, '')}/products/${encodeURIComponent(slug)}`,
      robots: 'noindex,follow',
    });
  }
  return sendStorefront(res, buildProductSeo(product, env.APP_URL));
}));

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /account\nDisallow: /checkout\nDisallow: /orders\nDisallow: /seller$\nDisallow: /garage\nDisallow: /messages\nDisallow: /wishlist\nDisallow: /notifications\nDisallow: /returns-center\nSitemap: ${env.APP_URL.replace(/\/$/, '')}/sitemap.xml\n`);
});

const SITEMAP_PRODUCT_PAGE_SIZE = 45_000;
const SITEMAP_STATIC_PATHS = ['/', '/shop', '/vehicles', '/build-advisor', '/marketplace', '/verified-fit', '/buyer-protection', '/shipping', '/returns', '/terms', '/privacy', '/cookies', '/seller-terms', '/prohibited-products', '/about'];
let sitemapIndexCache: { expiresAt: number; xml: string } | null = null;

app.get('/sitemap.xml', asyncHandler(async (_req, res) => {
  if (sitemapIndexCache && sitemapIndexCache.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.type('application/xml').send(sitemapIndexCache.xml);
  }
  const base = env.APP_URL.replace(/\/$/, '');
  const productCount = await prisma.product.count({ where: { status: 'ACTIVE' } });
  const productPages = Math.ceil(productCount / SITEMAP_PRODUCT_PAGE_SIZE);
  const sitemapUrls = [
    `${base}/sitemaps/static.xml`,
    ...Array.from({ length: productPages }, (_, index) => `${base}/sitemaps/products-${index + 1}.xml`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapUrls.map(url => `<sitemap><loc>${htmlEsc(url)}</loc></sitemap>`).join('')}</sitemapindex>`;
  sitemapIndexCache = { expiresAt: Date.now() + 60 * 60 * 1000, xml };
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(xml);
}));

app.get('/sitemaps/static.xml', (_req, res) => {
  const base = env.APP_URL.replace(/\/$/, '');
  const urls = SITEMAP_STATIC_PATHS.map(pathname => `<url><loc>${htmlEsc(base + pathname)}</loc></url>`).join('');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

app.get('/sitemaps/products-:page.xml', asyncHandler(async (req, res) => {
  const page = Number(req.params.page);
  if (!Number.isSafeInteger(page) || page < 1) return res.status(404).end();
  const skip = (page - 1) * SITEMAP_PRODUCT_PAGE_SIZE;
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE' },
    select: { slug: true, updatedAt: true },
    orderBy: [{ slug: 'asc' }],
    skip,
    take: SITEMAP_PRODUCT_PAGE_SIZE,
  });
  if (!products.length) return res.status(404).end();
  const base = env.APP_URL.replace(/\/$/, '');
  const urls = products.map(product => `<url><loc>${htmlEsc(`${base}/products/${encodeURIComponent(product.slug)}`)}</loc><lastmod>${product.updatedAt.toISOString()}</lastmod></url>`).join('');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
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
app.use('/api/admin/customer-intelligence', customerIntelligenceRouter);
app.use('/api/admin/readiness', readinessRouter);
app.use('/api/commerce', commerceRouter);
app.use('/api/admin/commerce', adminCommerceRouter);
app.use('/api/privacy', privacyRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin/analytics', adminAnalyticsRouter);
app.use('/api/admin/vinyasa', adminVinyasaRouter);
app.use('/api/integrations/vinyasa', vinyasaIntegrationRouter);
app.use('/api/admin/ops', opsRouter);
app.use('/api/supplier-feed', supplierFeedRouter);
app.use('/api/v2', v2Router);

// History-API storefront routes. Old #/ links remain supported by the browser router,
// but public/canonical URLs use normal paths so products and landing pages are crawlable.
const storefrontRoute = /^\/(?:shop|vehicles|vehicle-finder|build-advisor|advisor|requests|garage|builds(?:\/[^/]+)?|public-builds\/[^/]+|compare|wishlist|messages|sellers\/[^/]+|sell|seller|account|notifications|feed|profile\/[^/]+|checkout|orders\/[^/]+|returns-center|verified-fit|buyer-protection|shipping|returns|terms|privacy|cookies|seller-terms|prohibited-products|about|verify-email|email-change|reset-password|marketplace)\/?$/;
app.get(storefrontRoute, (_req, res) => sendStorefront(res));

app.use(notFound);
app.use(errorHandler);
