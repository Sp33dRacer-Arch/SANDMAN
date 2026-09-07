import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { env } from '../../config/env';
import {
  acquireVinyasaSyncLease,
  ensureVinyasaSupplier,
  previewVinyasaCatalog,
  repriceAllVinyasaProducts,
  releaseVinyasaSyncLease,
  startVinyasaImportJob,
  resumeVinyasaImportJob,
  syncVinyasaCatalog,
  syncVinyasaTracking,
  testVinyasaConnection,
  updateVinyasaProductPricing,
  vinyasaPricingRows,
  vinyasaStatus,
} from '../../services/vinyasa.service';

export const adminVinyasaRouter = Router();
adminVinyasaRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

adminVinyasaRouter.get('/status', asyncHandler(async (_req, res) => {
  res.json(await vinyasaStatus());
}));

adminVinyasaRouter.post('/test', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
  const result = await testVinyasaConnection();
  if (!result.ok) res.status(502);
  res.json(result);
}));

adminVinyasaRouter.get('/preview', asyncHandler(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit ?? 20);
  res.json({ items: await previewVinyasaCatalog(limit) });
}));

const relativeApiPath = z.string().trim().min(1).max(300).refine(value => !/^https?:\/\//i.test(value) && !value.includes('..') && !value.includes('\\'), 'Use a relative path on VINYASA_BASE_URL');

const settingsSchema = z.object({
  autoSyncEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  defaultMarkupPercent: z.number().min(10).max(800).optional(),
  minMarkupPercent: z.number().min(10).max(800).optional(),
  maxMarkupPercent: z.number().min(10).max(800).optional(),
  adaptivePricingEnabled: z.boolean().optional(),
  lowCostThresholdCents: z.number().int().min(1).max(100000000).optional(),
  lowCostMarkupPercent: z.number().min(10).max(800).optional(),
  midCostThresholdCents: z.number().int().min(1).max(100000000).optional(),
  midCostMarkupPercent: z.number().min(10).max(800).optional(),
  highCostMarkupPercent: z.number().min(10).max(800).optional(),
  useSupplierRetail: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  deactivateMissing: z.boolean().optional(),
  overwriteProductContent: z.boolean().optional(),
  overwriteImages: z.boolean().optional(),
  priceRounding: z.enum(['NONE', 'ENDING_99', 'ENDING_95', 'NEAREST_100']).optional(),
  paymentMode: z.enum(['wallet', 'card_on_file', 'manual']).optional(),
  supplierMoneyUnit: z.enum(['UNCONFIRMED', 'MAJOR', 'MINOR']).optional(),
  orderSubmissionEnabled: z.boolean().optional(),
  orderPayloadStyle: z.enum(['CAMEL', 'SNAKE']).optional(),
  productsPath: relativeApiPath.optional(),
  ordersPath: relativeApiPath.optional(),
  orderStatusPathTemplate: relativeApiPath.refine(value => value.includes('{id}'), 'Order status path must contain {id}').optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  maxImportProducts: z.number().int().min(1).max(1000000).optional(),
}).superRefine((value, ctx) => {
  const min = value.minMarkupPercent;
  const max = value.maxMarkupPercent;
  const def = value.defaultMarkupPercent;
  if (min != null && max != null && min > max) ctx.addIssue({ code: 'custom', message: 'Minimum markup cannot exceed maximum markup', path: ['minMarkupPercent'] });
  if (def != null && min != null && def < min) ctx.addIssue({ code: 'custom', message: 'Default markup cannot be below minimum markup', path: ['defaultMarkupPercent'] });
  if (def != null && max != null && def > max) ctx.addIssue({ code: 'custom', message: 'Default markup cannot exceed maximum markup', path: ['defaultMarkupPercent'] });
  if (value.lowCostThresholdCents != null && value.midCostThresholdCents != null && value.lowCostThresholdCents > value.midCostThresholdCents) {
    ctx.addIssue({ code: 'custom', message: 'Low-cost threshold cannot exceed mid-cost threshold', path: ['lowCostThresholdCents'] });
  }
});

adminVinyasaRouter.patch('/settings', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = settingsSchema.parse(req.body);
  const { supplier, config } = await ensureVinyasaSupplier();
  const min = body.minMarkupPercent ?? config.minMarkupPercent;
  const max = body.maxMarkupPercent ?? config.maxMarkupPercent;
  const def = body.defaultMarkupPercent ?? config.defaultMarkupPercent;
  if (min > max || def < min || def > max) throw new HttpError(400, 'Markup settings must satisfy 10% <= minimum <= default <= maximum <= 800%');
  const lowThreshold = body.lowCostThresholdCents ?? config.lowCostThresholdCents;
  const midThreshold = body.midCostThresholdCents ?? config.midCostThresholdCents;
  if (lowThreshold > midThreshold) throw new HttpError(400, 'Low-cost threshold cannot exceed mid-cost threshold');
  const updated = await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: body });
  res.json(updated);
}));

adminVinyasaRouter.post('/import-job', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = z.object({ maxProducts: z.number().int().min(1).max(1000000).optional() }).parse(req.body ?? {});
  const result = await startVinyasaImportJob(body.maxProducts);
  res.status(202).json(result);
}));

adminVinyasaRouter.post('/import-job/resume', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
  const result = await resumeVinyasaImportJob();
  res.status(202).json(result);
}));

adminVinyasaRouter.post('/sync', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = z.object({
    dryRun: z.boolean().default(false),
    mode: z.enum(['FULL', 'STOCK_PRICE']).default('FULL'),
    maxProducts: z.number().int().min(1).max(1000000).optional(),
  }).parse(req.body ?? {});
  const owner = await acquireVinyasaSyncLease();
  if (!owner) throw new HttpError(409, 'A Vinyasa sync is already running');
  try {
    res.json(await syncVinyasaCatalog({ ...body, leaseOwner: owner }));
  } finally {
    await releaseVinyasaSyncLease(owner).catch(() => undefined);
  }
}));

adminVinyasaRouter.post('/reprice', requireRole('ADMIN'), asyncHandler(async (_req, res) => {
  res.json(await repriceAllVinyasaProducts());
}));

adminVinyasaRouter.post('/tracking-sync', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = z.object({ limit: z.number().int().min(1).max(1000).default(200) }).parse(req.body ?? {});
  res.json(await syncVinyasaTracking(body.limit));
}));

adminVinyasaRouter.get('/products', asyncHandler(async (req, res) => {
  const take = z.coerce.number().int().min(1).max(1000).default(300).parse(req.query.take ?? 300);
  res.json({ items: await vinyasaPricingRows(take) });
}));

adminVinyasaRouter.patch('/products/:id/pricing', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const body = z.object({
    autoPrice: z.boolean().optional(),
    markupOverridePercent: z.number().min(10).max(800).nullable().optional(),
    retailOverrideCents: z.number().int().positive().nullable().optional(),
    applyNow: z.boolean().default(true),
  }).parse(req.body);
  res.json(await updateVinyasaProductPricing(routeParam(req.params.id, 'id'), body));
}));

function validSyncKey(value?: string) {
  if (!env.SANDMAN_VINYASA_SYNC_API_KEY || !value) return false;
  const expected = Buffer.from(env.SANDMAN_VINYASA_SYNC_API_KEY);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const vinyasaIntegrationRouter = Router();
vinyasaIntegrationRouter.post('/sync', asyncHandler(async (req, res) => {
  const auth = req.header('authorization');
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : req.header('x-sandman-vinyasa-key');
  if (!validSyncKey(key)) throw new HttpError(401, 'Invalid SANDMAN Vinyasa sync API key');
  const body = z.object({ mode: z.enum(['FULL', 'STOCK_PRICE', 'TRACKING', 'ALL']).default('STOCK_PRICE'), maxProducts: z.number().int().min(1).max(1000000).optional() }).parse(req.body ?? {});
  const owner = await acquireVinyasaSyncLease();
  if (!owner) return res.status(202).json({ skipped: true, reason: 'A Vinyasa sync is already running' });
  try {
    if (body.mode === 'TRACKING') return res.json({ tracking: await syncVinyasaTracking() });
    if (body.mode === 'ALL') {
      const catalog = await syncVinyasaCatalog({ mode: 'STOCK_PRICE', maxProducts: body.maxProducts, leaseOwner: owner });
      const tracking = await syncVinyasaTracking();
      return res.json({ catalog, tracking });
    }
    return res.json(await syncVinyasaCatalog({ mode: body.mode, maxProducts: body.maxProducts, leaseOwner: owner }));
  } finally {
    await releaseVinyasaSyncLease(owner).catch(() => undefined);
  }
}));
