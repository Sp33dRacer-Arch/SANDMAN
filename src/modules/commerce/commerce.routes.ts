import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { HttpError } from '../../lib/http-error';
import { routeParam } from '../../lib/route-param';
import { requireAuth, requireRole } from '../../middleware/auth';
import { commerceContext } from '../../services/global-commerce.service';
import { audit } from '../../services/audit.service';
import { env } from '../../config/env';

export const commerceRouter = Router();
export const adminCommerceRouter = Router();

const countryCode = z.string().trim().length(2).transform(value => value.toUpperCase());
const currencyCode = z.string().trim().length(3).transform(value => value.toUpperCase());
const paymentMethod = z.enum(['STRIPE', 'PAYPAL', 'BANK_TRANSFER']);

commerceRouter.get('/context', asyncHandler(async (req, res) => {
  const query = z.object({
    country: countryCode.optional(),
    currency: currencyCode.optional(),
  }).parse(req.query);
  res.json(await commerceContext(query.country, query.currency));
}));

adminCommerceRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'));

adminCommerceRouter.get('/overview', asyncHandler(async (_req, res) => {
  const [regions, rates, taxRules, zones, regionalPrices] = await Promise.all([
    prisma.commerceRegion.findMany({ orderBy: { country: 'asc' } }),
    prisma.fxRate.findMany({ orderBy: [{ baseCurrency: 'asc' }, { quoteCurrency: 'asc' }] }),
    prisma.taxRule.findMany({ orderBy: [{ country: 'asc' }, { priority: 'desc' }] }),
    prisma.shippingZone.findMany({ orderBy: { priority: 'desc' } }),
    prisma.regionalPrice.findMany({
      include: { product: { select: { id: true, sku: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  ]);
  res.json({
    settlementCurrency: env.CURRENCY.toUpperCase(),
    regions,
    rates,
    taxRules,
    zones,
    regionalPrices,
  });
}));

adminCommerceRouter.post('/regions', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    country: countryCode,
    locale: z.string().trim().min(2).max(30).default('en-US'),
    currency: currencyCode,
    shippingAllowed: z.boolean().default(false),
    taxRequired: z.boolean().default(true),
    dutiesRequired: z.boolean().default(false),
    paymentMethods: z.array(paymentMethod).min(1).max(3),
    importScheme: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).parse(req.body);
  const row = await prisma.commerceRegion.upsert({
    where: { country: data.country },
    update: data,
    create: data,
  });
  await audit({
    actorUserId: req.auth!.userId,
    action: 'COMMERCE_REGION_UPSERTED',
    targetType: 'COMMERCE_REGION',
    targetId: row.id,
    metadata: { country: data.country, shippingAllowed: data.shippingAllowed },
  });
  res.status(201).json(row);
}));

adminCommerceRouter.post('/fx-rates', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    baseCurrency: currencyCode.default(env.CURRENCY.toUpperCase()),
    quoteCurrency: currencyCode,
    rate: z.number().positive().max(1_000_000),
    source: z.string().trim().max(80).default('MANUAL'),
  }).parse(req.body);
  if (data.baseCurrency === data.quoteCurrency) throw new HttpError(400, 'Base and quote currencies must differ');
  if (data.baseCurrency !== env.CURRENCY.toUpperCase()) throw new HttpError(400, `FX base currency must be ${env.CURRENCY.toUpperCase()}`);
  const row = await prisma.fxRate.upsert({
    where: { baseCurrency_quoteCurrency: { baseCurrency: data.baseCurrency, quoteCurrency: data.quoteCurrency } },
    update: { rate: data.rate, source: data.source, fetchedAt: new Date() },
    create: { ...data, fetchedAt: new Date() },
  });
  await audit({ actorUserId: req.auth!.userId, action: 'FX_RATE_UPSERTED', targetType: 'FX_RATE', targetId: row.id, metadata: { pair: `${data.baseCurrency}/${data.quoteCurrency}` } });
  res.status(201).json(row);
}));

adminCommerceRouter.delete('/fx-rates/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  await prisma.fxRate.delete({ where: { id: routeParam(req.params.id, 'id') } });
  res.status(204).send();
}));

adminCommerceRouter.post('/tax-rules', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    country: countryCode,
    region: z.string().trim().max(40).optional(),
    label: z.string().trim().min(2).max(120),
    taxType: z.enum(['VAT', 'SALES_TAX', 'GST', 'OTHER']).default('VAT'),
    rateBps: z.number().int().min(0).max(10_000),
    taxInclusive: z.boolean().default(false),
    appliesToShipping: z.boolean().default(false),
    priority: z.number().int().min(0).max(10_000).default(100),
    active: z.boolean().default(true),
  }).parse(req.body);
  const row = await prisma.taxRule.create({ data: { ...data, region: data.region?.toUpperCase() } });
  await audit({ actorUserId: req.auth!.userId, action: 'TAX_RULE_CREATED', targetType: 'TAX_RULE', targetId: row.id, metadata: { country: row.country, region: row.region, rateBps: row.rateBps } });
  res.status(201).json(row);
}));

adminCommerceRouter.patch('/tax-rules/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    label: z.string().trim().min(2).max(120).optional(),
    rateBps: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    taxInclusive: z.boolean().optional(),
    appliesToShipping: z.boolean().optional(),
  }).parse(req.body);
  const row = await prisma.taxRule.update({ where: { id: routeParam(req.params.id, 'id') }, data });
  res.json(row);
}));

adminCommerceRouter.post('/shipping-zones', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const destination = z.union([countryCode, z.literal('*')]);
  const data = z.object({
    name: z.string().trim().min(2).max(120),
    countries: z.array(destination).min(1).max(250),
    currency: currencyCode.default(env.CURRENCY.toUpperCase()),
    rateCents: z.number().int().min(0),
    freeShippingThresholdCents: z.number().int().min(0).nullable().optional(),
    minDays: z.number().int().min(0).max(365).nullable().optional(),
    maxDays: z.number().int().min(0).max(365).nullable().optional(),
    carrierCode: z.string().trim().max(60).nullable().optional(),
    serviceCode: z.string().trim().max(60).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
    active: z.boolean().default(true),
  }).parse(req.body);
  if (data.currency !== env.CURRENCY.toUpperCase()) throw new HttpError(400, `Shipping zones must use ${env.CURRENCY.toUpperCase()} settlement currency`);
  if (data.minDays != null && data.maxDays != null && data.maxDays < data.minDays) throw new HttpError(400, 'Maximum delivery days cannot be less than minimum delivery days');
  const row = await prisma.shippingZone.create({ data });
  await audit({ actorUserId: req.auth!.userId, action: 'SHIPPING_ZONE_CREATED', targetType: 'SHIPPING_ZONE', targetId: row.id, metadata: { name: row.name } });
  res.status(201).json(row);
}));

adminCommerceRouter.patch('/shipping-zones/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    active: z.boolean().optional(),
    rateCents: z.number().int().min(0).optional(),
    freeShippingThresholdCents: z.number().int().min(0).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  }).parse(req.body);
  res.json(await prisma.shippingZone.update({ where: { id: routeParam(req.params.id, 'id') }, data }));
}));

adminCommerceRouter.post('/regional-prices', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  const data = z.object({
    productId: z.string().min(1),
    regionKey: z.string().trim().min(2).max(40).transform(value => value.toUpperCase()),
    currency: currencyCode,
    priceCents: z.number().int().min(0),
    compareAtCents: z.number().int().min(0).nullable().optional(),
  }).parse(req.body);
  if (!await prisma.product.count({ where: { id: data.productId } })) throw new HttpError(404, 'Product not found');
  const row = await prisma.regionalPrice.upsert({
    where: { productId_regionKey_currency: { productId: data.productId, regionKey: data.regionKey, currency: data.currency } },
    update: { priceCents: data.priceCents, compareAtCents: data.compareAtCents },
    create: data,
    include: { product: { select: { id: true, sku: true, name: true } } },
  });
  await audit({ actorUserId: req.auth!.userId, action: 'REGIONAL_PRICE_UPSERTED', targetType: 'REGIONAL_PRICE', targetId: row.id, metadata: { regionKey: row.regionKey, currency: row.currency } });
  res.status(201).json(row);
}));

adminCommerceRouter.delete('/regional-prices/:id', requireRole('ADMIN'), asyncHandler(async (req, res) => {
  await prisma.regionalPrice.delete({ where: { id: routeParam(req.params.id, 'id') } });
  res.status(204).send();
}));
