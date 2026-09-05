import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma, readPrisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { optionalAuth, requireAuth, requireRole } from '../../middleware/auth';
import { env } from '../../config/env';

export const analyticsRouter = Router();
export const adminAnalyticsRouter = Router();

const analyticsLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false });
const eventName = z.enum([
  'PAGE_VIEW', 'SEARCH', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT',
  'PURCHASE', 'FITMENT_CHECK', 'SELLER_VIEW', 'WISHLIST', 'RETURN_STARTED',
]);
const anonymousIdSchema = z.string().trim().min(12).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

async function forwardMarketingEvent(payload: Record<string, unknown>) {
  if (!env.MARKETING_EVENT_WEBHOOK_URL) return;
  void fetch(env.MARKETING_EVENT_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.MARKETING_EVENT_WEBHOOK_SECRET ? { authorization: `Bearer ${env.MARKETING_EVENT_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

analyticsRouter.post('/events', analyticsLimiter, optionalAuth, asyncHandler(async (req, res) => {
  const data = z.object({
    anonymousId: anonymousIdSchema,
    name: eventName,
    path: z.string().trim().max(500),
    metadata: z.record(z.string(), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])).optional(),
  }).parse(req.body);
  if (JSON.stringify(data.metadata || {}).length > 4_000) return res.status(204).send();

  const consent = await prisma.privacyConsent.findUnique({ where: { anonymousId: data.anonymousId } });
  if (!consent?.analytics) return res.status(204).send();

  const event = await prisma.analyticsEvent.create({
    data: {
      userId: req.auth?.userId,
      anonymousId: data.anonymousId,
      name: data.name,
      path: data.path,
      metadata: data.metadata,
    },
    select: { id: true, name: true, path: true, createdAt: true },
  });

  if (consent.marketing && env.MARKETING_EVENT_WEBHOOK_URL) {
    await forwardMarketingEvent({
      eventId: event.id,
      event: event.name,
      path: event.path,
      anonymousId: data.anonymousId,
      metadata: data.metadata || {},
      timestamp: event.createdAt.toISOString(),
    });
  }

  res.status(202).json({ accepted: true });
}));

adminAnalyticsRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

adminAnalyticsRouter.get('/summary', asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [groups, topPaths, consents] = await Promise.all([
    readPrisma.analyticsEvent.groupBy({ by: ['name'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    readPrisma.analyticsEvent.groupBy({
      by: ['path'], where: { createdAt: { gte: since }, name: 'PAGE_VIEW' },
      _count: { _all: true }, orderBy: { _count: { path: 'desc' } }, take: 12,
    }),
    readPrisma.privacyConsent.findMany({ select: { analytics: true, marketing: true, preferences: true } }),
  ]);
  const counts = Object.fromEntries(groups.map(group => [group.name, group._count._all]));
  const records = consents.length;
  const productViews = counts.PRODUCT_VIEW || 0;
  const addToCart = counts.ADD_TO_CART || 0;
  const beginCheckout = counts.BEGIN_CHECKOUT || 0;
  const purchases = counts.PURCHASE || 0;
  res.json({
    since,
    eventCounts: counts,
    funnel: {
      productViews,
      addToCart,
      beginCheckout,
      purchases,
      productToCartRate: productViews ? addToCart / productViews : 0,
      cartToCheckoutRate: addToCart ? beginCheckout / addToCart : 0,
      checkoutToPurchaseRate: beginCheckout ? purchases / beginCheckout : 0,
    },
    topPaths: topPaths.map(row => ({ path: row.path, views: row._count._all })),
    consent: {
      records,
      analyticsOptInRate: records ? consents.filter(row => row.analytics).length / records : 0,
      marketingOptInRate: records ? consents.filter(row => row.marketing).length / records : 0,
      preferencesOptInRate: records ? consents.filter(row => row.preferences).length / records : 0,
    },
  });
}));
