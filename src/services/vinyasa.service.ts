import { randomUUID } from 'crypto';
import type { Prisma, Supplier } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { processProductAlerts } from './product-alert.service';
import { recomputeOrderFulfillmentStatus } from './order-lifecycle.service';
import { createNotification } from './notification.service';
import { sendEmail } from './email.service';
import { setSupplierReportedStock } from './supplier-inventory.service';
import type { SupplierAdapter, SubmitSupplierOrderInput, SubmitSupplierOrderResult, SupplierTrackingResult } from './supplier-adapter';
import {
  calculateVinyasaRetailPrice,
  extractVinyasaItems,
  extractVinyasaNext,
  hasVinyasaCatalogCollection,
  normalizeVinyasaProduct,
  slugifyVinyasa,
  type VinyasaNormalizedProduct,
  type VinyasaPriceDecision,
} from './vinyasa-normalizer';

const DEFAULT_BASE_URL = 'https://vinyasapartners.com/api/v1/reseller';
const DEFAULT_PRODUCTS_PATH = '/products';
const DEFAULT_ORDERS_PATH = '/orders';
const DEFAULT_ORDER_STATUS_PATH = '/orders/{id}';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PREVIEW = 100;
export const MAX_VINYASA_IMPORT_PRODUCTS = 5_000_000;
const IMAGE_REPAIR_REQUEST_DELAY_MS = 550;

const cleanPath = (value: string) => `/${value.trim().replace(/^\/+/, '')}`;
const baseUrl = () => (env.VINYASA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const authKey = () => env.VINYASA_API_KEY?.trim();

function endpoint(path: string, query?: Record<string, string | number | undefined>) {
  const raw = path.trim();
  if (!raw || /^https?:\/\//i.test(raw) || raw.includes('\\') || raw.split('/').includes('..')) {
    throw new HttpError(400, 'Vinyasa API paths must be relative paths on VINYASA_BASE_URL.');
  }
  const base = new URL(`${baseUrl()}/`);
  const url = new URL(cleanPath(raw).replace(/^\//, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) {
    throw new HttpError(400, 'Vinyasa API path escaped the configured Vinyasa base URL.');
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return { rawText: text.slice(0, 4000) }; }
}

async function requestVinyasa(path: string, init: RequestInit = {}, query?: Record<string, string | number | undefined>) {
  const key = authKey();
  if (!key) throw new HttpError(503, 'Vinyasa is not configured. Set VINYASA_API_KEY in the backend environment.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.VINYASA_REQUEST_TIMEOUT_MS ?? REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    if (env.VINYASA_AUTH_STYLE === 'x-api-key') headers.set('X-API-Key', key);
    else headers.set('Authorization', `Bearer ${key}`);
    const response = await fetch(endpoint(path, query), { ...init, headers, signal: controller.signal });
    const body = await parseResponse(response);
    if (!response.ok) {
      const message = body && typeof body === 'object' && !Array.isArray(body)
        ? String((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error ?? `Vinyasa API returned ${response.status}`)
        : `Vinyasa API returned ${response.status}`;
      const error = new HttpError(response.status >= 500 ? 502 : response.status, message.slice(0, 700));
      (error as HttpError & { upstreamStatus?: number }).upstreamStatus = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new HttpError(504, 'Vinyasa API request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function vinyasaConfigured() {
  return Boolean(authKey());
}

export async function ensureVinyasaSupplier() {
  const supplier = await prisma.supplier.upsert({
    where: { code: 'vinyasa' },
    update: {
      name: 'Vinyasa',
      active: true,
      baseUrl: baseUrl(),
      apiKeyEnvName: 'VINYASA_API_KEY',
    },
    create: {
      name: 'Vinyasa',
      code: 'vinyasa',
      type: 'CUSTOM',
      active: true,
      priority: 100,
      baseUrl: baseUrl(),
      apiKeyEnvName: 'VINYASA_API_KEY',
    },
  });

  const config = await prisma.supplierIntegrationConfig.upsert({
    where: { supplierId: supplier.id },
    update: {},
    create: {
      supplierId: supplier.id,
      provider: 'vinyasa',
      autoSyncEnabled: env.VINYASA_AUTO_SYNC_ENABLED,
      syncIntervalMinutes: env.VINYASA_SYNC_INTERVAL_MINUTES,
      defaultMarkupPercent: env.VINYASA_DEFAULT_MARKUP_PERCENT,
      minMarkupPercent: env.VINYASA_MIN_MARKUP_PERCENT,
      maxMarkupPercent: env.VINYASA_MAX_MARKUP_PERCENT,
      adaptivePricingEnabled: env.VINYASA_ADAPTIVE_PRICING_ENABLED,
      lowCostThresholdCents: env.VINYASA_LOW_COST_THRESHOLD_CENTS,
      lowCostMarkupPercent: env.VINYASA_LOW_COST_MARKUP_PERCENT,
      midCostThresholdCents: env.VINYASA_MID_COST_THRESHOLD_CENTS,
      midCostMarkupPercent: env.VINYASA_MID_COST_MARKUP_PERCENT,
      highCostMarkupPercent: env.VINYASA_HIGH_COST_MARKUP_PERCENT,
      useSupplierRetail: env.VINYASA_USE_SUPPLIER_RETAIL,
      autoPublish: env.VINYASA_AUTO_PUBLISH,
      deactivateMissing: env.VINYASA_DEACTIVATE_MISSING,
      paymentMode: env.VINYASA_PAYMENT_MODE,
      productsPath: DEFAULT_PRODUCTS_PATH,
      ordersPath: DEFAULT_ORDERS_PATH,
      orderStatusPathTemplate: DEFAULT_ORDER_STATUS_PATH,
      maxImportProducts: env.VINYASA_MAX_IMPORT_PRODUCTS,
      supplierMoneyUnit: env.VINYASA_MONEY_UNIT,
      orderSubmissionEnabled: env.VINYASA_ORDER_SUBMISSION_ENABLED,
      orderPayloadStyle: env.VINYASA_ORDER_PAYLOAD_STYLE,
    },
  });
  return { supplier, config };
}

export async function vinyasaStatus() {
  const { supplier, config } = await ensureVinyasaSupplier();
  const [linked, active, syncRuns] = await Promise.all([
    prisma.supplierProduct.count({ where: { supplierId: supplier.id } }),
    prisma.supplierProduct.count({ where: { supplierId: supplier.id, active: true } }),
    prisma.supplierSyncRun.findMany({ where: { supplierId: supplier.id }, orderBy: { startedAt: 'desc' }, take: 10 }),
  ]);
  return {
    configured: vinyasaConfigured(),
    supplier,
    config,
    linkedProducts: linked,
    activeProducts: active,
    syncRuns,
    apiKeyPresent: vinyasaConfigured(),
    apiKeyEnvName: 'VINYASA_API_KEY',
    syncApiKeyPresent: Boolean(env.SANDMAN_VINYASA_SYNC_API_KEY),
    baseUrl: baseUrl(),
  };
}

const candidateProductPaths = (preferred: string) => [...new Set([preferred, '/products', '/catalog', '/catalogue', '/catalog/products', '/catalogue/products', '/feed/products', '/inventory/products'])];

export async function testVinyasaConnection() {
  const { supplier, config } = await ensureVinyasaSupplier();
  const attempts: Array<{ path: string; ok: boolean; status?: number; message?: string }> = [];
  for (const path of candidateProductPaths(config.productsPath)) {
    try {
      const payload = await requestVinyasa(path, { method: 'GET' }, { limit: 1, page: 1 });
      const items = extractVinyasaItems(payload);
      if (!hasVinyasaCatalogCollection(payload)) {
        attempts.push({ path, ok: false, message: 'Endpoint returned 200 but did not expose a recognizable product collection.' });
        continue;
      }
      attempts.push({ path, ok: true });
      if (path !== config.productsPath) {
        await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { productsPath: path } });
      }
      const first = items[0];
      const normalized = first ? normalizeVinyasaProduct(first, config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR') : null;
      return {
        ok: true,
        detectedProductsPath: path,
        sampleCount: items.length,
        sample: normalized ? {
          supplierProductId: normalized.supplierProductId,
          sku: normalized.supplierSku,
          name: normalized.name,
          costCents: normalized.costCents,
          suggestedRetailCents: normalized.suggestedRetailCents ?? null,
          currency: normalized.currency,
          stock: normalized.stock,
          imageCount: normalized.images.length,
        } : null,
        discoveredKeys: first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first as object).slice(0, 60) : [],
        attempts,
      };
    } catch (error) {
      const status = (error as HttpError & { upstreamStatus?: number }).upstreamStatus;
      attempts.push({ path, ok: false, status, message: error instanceof Error ? error.message : 'Unknown error' });
      if (status && ![404, 405].includes(status)) break;
    }
  }
  return { ok: false, attempts };
}

async function fetchCatalogPage(path: string, page: number, pageSize: number, cursor?: string) {
  const query: Record<string, string | number | undefined> = { limit: pageSize, page };
  if (cursor) query.after = cursor;
  const payload = await requestVinyasa(path, { method: 'GET' }, query);
  return { payload, items: extractVinyasaItems(payload), next: extractVinyasaNext(payload) };
}

async function pricingRuleFor(supplierId: string, categoryId: string) {
  const rules = await prisma.pricingRule.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ supplierId: null }, { supplierId }] },
        { OR: [{ categoryId: null }, { categoryId }] },
      ],
    },
    orderBy: { priority: 'asc' },
    take: 1,
  });
  return rules[0] ?? null;
}

async function priceDecision(input: {
  supplierId: string;
  categoryId: string;
  row: VinyasaNormalizedProduct;
  config: Awaited<ReturnType<typeof ensureVinyasaSupplier>>['config'];
  link?: { markupOverridePercent: number | null; retailOverrideCents: number | null } | null;
}) {
  const rule = await pricingRuleFor(input.supplierId, input.categoryId);
  return calculateVinyasaRetailPrice({
    costCents: input.row.costCents,
    shippingCents: input.row.shippingCents,
    suggestedRetailCents: input.row.suggestedRetailCents,
    markupOverridePercent: input.link?.markupOverridePercent,
    retailOverrideCents: input.link?.retailOverrideCents,
    pricingRuleMarkupPercent: rule?.markupPercent,
    pricingRuleFixedMarkupCents: rule?.fixedMarkupCents,
    pricingRuleMinimumProfitCents: rule?.minimumProfitCents,
    policy: {
      defaultMarkupPercent: input.config.defaultMarkupPercent,
      minMarkupPercent: input.config.minMarkupPercent,
      maxMarkupPercent: input.config.maxMarkupPercent,
      adaptivePricingEnabled: input.config.adaptivePricingEnabled,
      lowCostThresholdCents: input.config.lowCostThresholdCents,
      lowCostMarkupPercent: input.config.lowCostMarkupPercent,
      midCostThresholdCents: input.config.midCostThresholdCents,
      midCostMarkupPercent: input.config.midCostMarkupPercent,
      highCostMarkupPercent: input.config.highCostMarkupPercent,
      useSupplierRetail: input.config.useSupplierRetail,
      priceRounding: ['NONE', 'ENDING_99', 'ENDING_95', 'NEAREST_100'].includes(input.config.priceRounding)
        ? input.config.priceRounding as 'NONE' | 'ENDING_99' | 'ENDING_95' | 'NEAREST_100'
        : 'ENDING_99',
    },
  });
}

async function ensureCategory(row: VinyasaNormalizedProduct) {
  return prisma.category.upsert({
    where: { slug: row.categorySlug },
    update: { name: row.categoryName },
    create: { name: row.categoryName, slug: row.categorySlug, description: `Imported from Vinyasa Automotive.` },
  });
}

async function uniqueProductSlug(row: VinyasaNormalizedProduct, existingProductId?: string) {
  const base = slugifyVinyasa(`${row.brand ?? ''}-${row.name}-${row.supplierSku}`);
  const found = await prisma.product.findUnique({ where: { slug: base }, select: { id: true } });
  if (!found || found.id === existingProductId) return base;
  return `${base}-${slugifyVinyasa(row.supplierProductId).slice(-16)}`.slice(0, 160);
}

async function productForNewLink(row: VinyasaNormalizedProduct) {
  const bySku = await prisma.product.findUnique({ where: { sku: row.supplierSku } });
  if (!bySku || bySku.sourceType === 'DROPSHIP') return bySku;
  const prefixedSku = `VINYASA-${row.supplierSku}`;
  return prisma.product.findUnique({ where: { sku: prefixedSku } });
}

async function syncFitments(productId: string, row: VinyasaNormalizedProduct) {
  if (!row.fitments.length) return 0;
  const ids = new Set<string>();
  for (const fitment of row.fitments) {
    if (fitment.vehicleVariantId) {
      const exists = await prisma.vehicleVariant.findUnique({ where: { id: fitment.vehicleVariantId }, select: { id: true } });
      if (exists) ids.add(exists.id);
      continue;
    }
    if (!fitment.engineCode) continue;
    const candidates = await prisma.vehicleVariant.findMany({
      where: { engineCode: fitment.engineCode },
      select: { id: true, yearStart: true, yearEnd: true },
      take: 100,
    });
    for (const variant of candidates) {
      const overlaps = (fitment.yearStart == null || variant.yearEnd >= fitment.yearStart)
        && (fitment.yearEnd == null || variant.yearStart <= fitment.yearEnd);
      if (overlaps) ids.add(variant.id);
    }
  }
  if (!ids.size) return 0;
  await prisma.productFitment.createMany({
    data: [...ids].map(vehicleVariantId => ({
      productId,
      vehicleVariantId,
      verified: false,
      compatibility: 'FITS',
      source: 'SUPPLIER',
      notes: 'Imported from Vinyasa supplier compatibility data; not independently verified by SANDMAN.',
    })),
    skipDuplicates: true,
  });
  return ids.size;
}

async function importOne(row: VinyasaNormalizedProduct, supplier: Supplier, config: Awaited<ReturnType<typeof ensureVinyasaSupplier>>['config']) {
  if (row.costCents <= 0) {
    throw new Error(`Vinyasa ${row.supplierSku} has no positive dealer cost; SANDMAN will not auto-publish a zero-cost product.`);
  }
  if (row.currency.toUpperCase() !== env.CURRENCY.toUpperCase()) {
    throw new Error(`Vinyasa ${row.supplierSku} uses ${row.currency}; SANDMAN settlement currency is ${env.CURRENCY}. Configure matching supplier pricing before publishing.`);
  }

  const category = await ensureCategory(row);
  const existingLink = await prisma.supplierProduct.findUnique({
    where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } },
    include: { product: true },
  });
  let product = existingLink?.product ?? await productForNewLink(row);
  const decision = await priceDecision({ supplierId: supplier.id, categoryId: category.id, row, config, link: existingLink });
  const sku = product?.sku ?? (await prisma.product.findUnique({ where: { sku: row.supplierSku } }) ? `VINYASA-${row.supplierSku}` : row.supplierSku);
  const slug = await uniqueProductSlug(row, product?.id);
  const publishStatus = config.autoPublish && row.stockKnown && row.stock > 0 ? 'ACTIVE' : 'DRAFT';

  const commonData = {
    name: row.name,
    brand: row.brand,
    manufacturerPn: row.manufacturerPn,
    description: row.description,
    shortDesc: row.shortDesc,
    categoryId: category.id,
    priceCents: decision.priceCents,
    currency: row.currency.toUpperCase(),
    weightGrams: row.weightGrams,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    requiresFitment: row.requiresFitment,
    isUniversal: row.isUniversal,
    taxable: row.taxable,
    sourceType: 'DROPSHIP' as const,
    condition: 'NEW' as const,
    stockQuantity: row.stock,
    warrantyText: row.warrantyText,
    returnDays: row.returnDays,
    specs: row.specs as Prisma.InputJsonValue | undefined,
    videoUrl: row.videoUrl,
    hsCode: row.hsCode,
    countryOfOrigin: row.countryOfOrigin,
    customsDescription: row.customsDescription,
    shippingMinDays: row.leadTimeDays,
    shippingMaxDays: row.leadTimeDays == null ? undefined : row.leadTimeDays + 7,
    seoTitle: `${row.name}${row.brand ? ` | ${row.brand}` : ''} — SANDMAN`.slice(0, 180),
    seoDescription: (row.shortDesc || row.description).slice(0, 300),
  };

  if (!product) {
    product = await prisma.product.create({
      data: { ...commonData, sku, slug, status: publishStatus },
    });
  } else {
    const contentData = config.overwriteProductContent ? { ...commonData, slug } : {
      priceCents: decision.priceCents,
      currency: row.currency.toUpperCase(),
      stockQuantity: row.stock,
      shippingMinDays: row.leadTimeDays,
      shippingMaxDays: row.leadTimeDays == null ? undefined : row.leadTimeDays + 7,
    };
    product = await prisma.product.update({
      where: { id: product.id },
      data: { ...contentData, ...(config.autoPublish && product.status === 'DRAFT' && row.stockKnown && row.stock > 0 ? { status: 'ACTIVE' as const } : {}) },
    });
  }

  const previousAvailableStock = existingLink?.availableStock ?? null;
  const link = await prisma.$transaction(async tx => {
    const upserted = await tx.supplierProduct.upsert({
      where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } },
      update: {
        productId: product!.id,
        supplierSku: row.supplierSku,
        costCents: row.costCents,
        shippingCents: row.shippingCents,
        currency: row.currency.toUpperCase(),
        active: row.stockKnown,
        leadTimeDays: row.leadTimeDays,
        warehouseCountry: row.warehouseCountry,
        suggestedRetailCents: row.suggestedRetailCents,
        lastPriceAppliedAt: new Date(),
        lastSyncedAt: new Date(),
        rawData: row.raw as Prisma.InputJsonValue,
      },
      create: {
        supplierId: supplier.id,
        productId: product!.id,
        supplierProductId: row.supplierProductId,
        supplierSku: row.supplierSku,
        costCents: row.costCents,
        shippingCents: row.shippingCents,
        currency: row.currency.toUpperCase(),
        stock: row.stock,
        availableStock: row.stock,
        active: row.stockKnown,
        leadTimeDays: row.leadTimeDays,
        warehouseCountry: row.warehouseCountry,
        suggestedRetailCents: row.suggestedRetailCents,
        lastPriceAppliedAt: new Date(),
        lastSyncedAt: new Date(),
        rawData: row.raw as Prisma.InputJsonValue,
      },
    });
    await setSupplierReportedStock(tx, upserted.id, row.stock);
    return upserted;
  });

  if (previousAvailableStock !== row.stock) {
    await processProductAlerts({ productId: product.id, previousStock: previousAvailableStock, newStock: row.stock }).catch(() => undefined);
  }

  if (config.overwriteImages && row.images.length) {
    await prisma.$transaction(async tx => {
      await tx.productImage.deleteMany({ where: { productId: product!.id } });
      await tx.productImage.createMany({
        data: row.images.map((url, position) => ({ productId: product!.id, url, position, alt: `${row.name}${position ? ` image ${position + 1}` : ''}` })),
      });
    });
  }

  const fitmentsImported = await syncFitments(product.id, row);
  return { product, link, decision, fitmentsImported };
}

async function replaceVinyasaProductImages(productId: string, name: string, urls: string[]) {
  const unique = [...new Set(urls.filter(url => /^https:\/\//i.test(url)))].slice(0, 12);
  if (!unique.length) return 0;
  await prisma.$transaction(async tx => {
    await tx.productImage.deleteMany({ where: { productId } });
    await tx.productImage.createMany({
      data: unique.map((url, position) => ({ productId, url, position, alt: name + (position ? ' image ' + (position + 1) : '') })),
    });
  });
  return unique.length;
}

const waitForVinyasaImageRepair = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchVinyasaProductDetailForImageRepair(supplierProductId: string) {
  return requestVinyasa('/products/' + encodeURIComponent(supplierProductId), { method: 'GET' });
}

export async function repairVinyasaMissingImagesBatch(input: { limit?: number; afterId?: string } = {}) {
  const { supplier, config } = await ensureVinyasaSupplier();
  if (!vinyasaConfigured()) throw new HttpError(503, 'Set VINYASA_API_KEY before repairing Vinyasa images.');
  if (!config.overwriteImages) throw new HttpError(409, 'Enable “Keep product images synced from Vinyasa” before running image repair.');
  if (!['MAJOR', 'MINOR'].includes(config.supplierMoneyUnit)) throw new HttpError(409, 'Confirm Vinyasa supplier money units before repairing product images.');
  const moneyUnit = config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR';
  const take = Math.min(100, Math.max(1, Math.round(input.limit ?? env.VINYASA_IMAGE_REPAIR_BATCH_PRODUCTS)));
  const links = await prisma.supplierProduct.findMany({
    where: {
      supplierId: supplier.id,
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
      product: { status: 'ACTIVE', images: { none: {} } },
    },
    include: { product: { select: { id: true, name: true } } },
    orderBy: { id: 'asc' },
    take,
  });

  let repaired = 0;
  let noSupplierImage = 0;
  let errors = 0;
  let detailRequests = 0;
  const samples: Array<{ sku: string; status: string; imageCount?: number; error?: string }> = [];

  for (const link of links) {
    try {
      let normalized = normalizeVinyasaProduct(link.rawData, moneyUnit);
      let images = normalized?.images ?? [];
      if (!images.length) {
        detailRequests += 1;
        try {
          const detail = await fetchVinyasaProductDetailForImageRepair(link.supplierProductId);
          normalized = normalizeVinyasaProduct(detail, moneyUnit);
          images = normalized?.images ?? [];
        } finally {
          await waitForVinyasaImageRepair(IMAGE_REPAIR_REQUEST_DELAY_MS);
        }
      }
      if (!images.length) {
        noSupplierImage += 1;
        if (samples.length < 20) samples.push({ sku: link.supplierSku ?? link.product.name, status: 'NO_SUPPLIER_IMAGE' });
        continue;
      }
      const imageCount = await replaceVinyasaProductImages(link.productId, link.product.name, images);
      repaired += 1;
      if (samples.length < 20) samples.push({ sku: link.supplierSku ?? link.product.name, status: 'REPAIRED', imageCount });
    } catch (error) {
      errors += 1;
      if (samples.length < 20) samples.push({ sku: link.supplierSku ?? link.product.name, status: 'ERROR', error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown repair error' });
    }
  }

  return {
    scanned: links.length,
    repaired,
    noSupplierImage,
    errors,
    detailRequests,
    nextCursor: links.at(-1)?.id ?? input.afterId ?? null,
    completed: links.length < take,
    samples,
  };
}

export async function startVinyasaImageRepairJob(maxProducts?: number) {
  const { supplier, config } = await ensureVinyasaSupplier();
  if (!vinyasaConfigured()) throw new HttpError(503, 'Set VINYASA_API_KEY before starting Vinyasa image repair.');
  if (!config.overwriteImages) throw new HttpError(409, 'Enable “Keep product images synced from Vinyasa” before running image repair.');
  if (config.importJobStatus === 'RUNNING') return { started: false, status: config.importJobStatus, processed: config.importJobProcessed };
  const ceiling = Math.min(MAX_VINYASA_IMPORT_PRODUCTS, Math.max(1, Math.round(maxProducts ?? MAX_VINYASA_IMPORT_PRODUCTS)));
  const startedAt = new Date();
  await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: {
    maxImportProducts: ceiling,
    importJobStatus: 'RUNNING',
    importJobMode: 'IMAGES',
    importJobPage: 1,
    importJobCursor: null,
    importJobProcessed: 0,
    importJobErrors: 0,
    importJobStartedAt: startedAt,
    importJobUpdatedAt: startedAt,
    lastSyncMessage: 'Queued missing-image repair for active Vinyasa products',
  } });
  setImmediate(() => void resumeVinyasaImportJob().catch(error => console.error('Vinyasa background image repair failed', error)));
  return { started: true, status: 'RUNNING', mode: 'IMAGES', maxProducts: ceiling };
}

export async function previewVinyasaCatalog(limit = 20) {
  const { config } = await ensureVinyasaSupplier();
  const size = Math.min(MAX_PREVIEW, Math.max(1, Math.round(limit)));
  const { items } = await fetchCatalogPage(config.productsPath, 1, size);
  if (!['MAJOR', 'MINOR'].includes(config.supplierMoneyUnit)) throw new HttpError(409, 'Confirm whether Vinyasa feed prices are MAJOR units (e.g. 75.50) or MINOR units/cents (e.g. 7550) before preview/import.');
  const unit = config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR';
  const rows = items.slice(0, size).map(item => normalizeVinyasaProduct(item, unit)).filter((item): item is VinyasaNormalizedProduct => Boolean(item));
  return rows.map(row => ({
    supplierProductId: row.supplierProductId,
    supplierSku: row.supplierSku,
    name: row.name,
    brand: row.brand,
    categoryName: row.categoryName,
    costCents: row.costCents,
    shippingCents: row.shippingCents,
    suggestedRetailCents: row.suggestedRetailCents ?? null,
    currency: row.currency,
    stock: row.stock,
    imageCount: row.images.length,
    recommended: calculateVinyasaRetailPrice({
      costCents: row.costCents,
      shippingCents: row.shippingCents,
      suggestedRetailCents: row.suggestedRetailCents,
      policy: {
        defaultMarkupPercent: config.defaultMarkupPercent,
        minMarkupPercent: config.minMarkupPercent,
        maxMarkupPercent: config.maxMarkupPercent,
        adaptivePricingEnabled: config.adaptivePricingEnabled,
        lowCostThresholdCents: config.lowCostThresholdCents,
        lowCostMarkupPercent: config.lowCostMarkupPercent,
        midCostThresholdCents: config.midCostThresholdCents,
        midCostMarkupPercent: config.midCostMarkupPercent,
        highCostMarkupPercent: config.highCostMarkupPercent,
        useSupplierRetail: config.useSupplierRetail,
        priceRounding: ['NONE', 'ENDING_99', 'ENDING_95', 'NEAREST_100'].includes(config.priceRounding)
          ? config.priceRounding as 'NONE' | 'ENDING_99' | 'ENDING_95' | 'NEAREST_100'
          : 'ENDING_99',
      },
    }),
  }));
}

export async function syncVinyasaCatalog(options: { dryRun?: boolean; maxProducts?: number; mode?: 'FULL' | 'STOCK_PRICE'; startPage?: number; startCursor?: string; progressSupplierId?: string; progressBaseProcessed?: number; progressBaseErrors?: number; jobStartedAt?: Date; leaseOwner?: string } = {}) {
  const { supplier, config } = await ensureVinyasaSupplier();
  if (!vinyasaConfigured()) throw new HttpError(503, 'Set VINYASA_API_KEY before syncing the Vinyasa catalog.');
  if (!['MAJOR', 'MINOR'].includes(config.supplierMoneyUnit)) throw new HttpError(409, 'Confirm Vinyasa supplier money units before importing products.');
  const moneyUnit = config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR';
  const maxProducts = Math.min(config.maxImportProducts, Math.max(1, Math.round(options.maxProducts ?? config.maxImportProducts)));
  const run = await prisma.supplierSyncRun.create({ data: { supplierId: supplier.id, status: 'RUNNING' } });
  const seenIds = new Set<string>();
  const sample: Array<Record<string, unknown>> = [];
  let page = Math.max(1, options.startPage ?? 1);
  let cursor: string | undefined = options.startCursor;
  let productsSeen = 0;
  let productsUpdated = 0;
  let stockUpdates = 0;
  let priceUpdates = 0;
  let skipped = 0;
  let errors = 0;
  let completedCatalog = false;

  try {
    while (productsSeen < maxProducts) {
      const remaining = maxProducts - productsSeen;
      const pageSize = Math.min(config.pageSize, remaining);
      const fetched = await fetchCatalogPage(config.productsPath, page, pageSize, cursor);
      if (!fetched.items.length) { completedCatalog = true; break; }
      const rows = fetched.items.map(item => normalizeVinyasaProduct(item, moneyUnit)).filter((item): item is VinyasaNormalizedProduct => Boolean(item));
      productsSeen += fetched.items.length;

      for (const row of rows) {
        seenIds.add(row.supplierProductId);
        if (sample.length < 30) sample.push({ sku: row.supplierSku, name: row.name, costCents: row.costCents, suggestedRetailCents: row.suggestedRetailCents ?? null, stock: row.stock, currency: row.currency });
        if (options.dryRun) continue;
        try {
          if (options.mode === 'STOCK_PRICE') {
            const existing = await prisma.supplierProduct.findUnique({
              where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } },
              include: { product: true },
            });
            if (!existing) { skipped += 1; continue; }
            const previousStock = existing.availableStock;
            const categoryId = existing.product.categoryId;
            const decision = await priceDecision({ supplierId: supplier.id, categoryId, row, config, link: existing });
            await prisma.$transaction(async tx => {
              await tx.supplierProduct.update({ where: { id: existing.id }, data: {
                costCents: row.costCents,
                shippingCents: row.shippingCents,
                suggestedRetailCents: row.suggestedRetailCents,
                currency: row.currency.toUpperCase(),
                active: row.stockKnown,
                leadTimeDays: row.leadTimeDays,
                warehouseCountry: row.warehouseCountry,
                lastSyncedAt: new Date(),
                rawData: row.raw as Prisma.InputJsonValue,
              } });
              await setSupplierReportedStock(tx, existing.id, row.stock);
              await tx.product.update({ where: { id: existing.productId }, data: {
                stockQuantity: row.stock,
                ...(existing.autoPrice && existing.product.priceCents !== decision.priceCents ? { priceCents: decision.priceCents } : {}),
              } });
              if (existing.autoPrice && existing.product.priceCents !== decision.priceCents) {
                await tx.supplierProduct.update({ where: { id: existing.id }, data: { lastPriceAppliedAt: new Date() } });
              }
            });
            if (previousStock !== row.stock) stockUpdates += 1;
            if (existing.autoPrice && existing.product.priceCents !== decision.priceCents) {
              priceUpdates += 1;
              await processProductAlerts({ productId: existing.productId, previousPriceCents: existing.product.priceCents, newPriceCents: decision.priceCents }).catch(() => undefined);
            }
            productsUpdated += 1;
          } else {
            const existing = await prisma.supplierProduct.findUnique({ where: { supplierId_supplierProductId: { supplierId: supplier.id, supplierProductId: row.supplierProductId } }, include: { product: true } });
            const result = await importOne(row, supplier, config);
            productsUpdated += 1;
            if (existing?.availableStock !== row.stock) stockUpdates += 1;
            if (!existing || existing.product.priceCents !== result.decision.priceCents) priceUpdates += 1;
          }
        } catch (error) {
          errors += 1;
          if (sample.length < 30) sample.push({ sku: row.supplierSku, error: error instanceof Error ? error.message : 'Import failed' });
        }
      }

      const next = fetched.next;
      let nextPageForResume = page + 1;
      let nextCursorForResume: string | undefined;
      let pageCompletedCatalog = false;
      if (next.nextCursor && next.nextCursor !== cursor) {
        nextCursorForResume = next.nextCursor;
      } else if (next.nextPage && next.nextPage > page) {
        nextPageForResume = next.nextPage;
      } else if (next.hasMore === false || fetched.items.length < pageSize) {
        pageCompletedCatalog = true;
      }
      if (options.progressSupplierId) {
        await prisma.supplierIntegrationConfig.update({ where: { supplierId: options.progressSupplierId }, data: {
          importJobPage: nextPageForResume,
          importJobCursor: nextCursorForResume ?? null,
          importJobProcessed: (options.progressBaseProcessed ?? 0) + productsSeen,
          importJobErrors: (options.progressBaseErrors ?? 0) + errors,
          importJobUpdatedAt: new Date(),
        } });
      }
      if (options.leaseOwner) {
        await prisma.supplierIntegrationConfig.updateMany({ where: { supplierId: supplier.id, syncLeaseOwner: options.leaseOwner }, data: {
          syncLeaseUntil: new Date(Date.now() + env.VINYASA_SYNC_LEASE_MINUTES * 60_000),
        } });
      }
      if (pageCompletedCatalog) { completedCatalog = true; break; }
      cursor = nextCursorForResume;
      page = nextPageForResume;
    }

    if (!options.dryRun && options.mode !== 'STOCK_PRICE' && config.deactivateMissing && completedCatalog) {
      const links = await prisma.supplierProduct.findMany({ where: {
        supplierId: supplier.id,
        active: true,
        ...(options.jobStartedAt ? { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: options.jobStartedAt } }] } : {}),
      }, select: { id: true, productId: true, supplierProductId: true } });
      const missing = options.jobStartedAt ? links : links.filter(link => !seenIds.has(link.supplierProductId));
      for (const link of missing) {
        await prisma.supplierProduct.update({ where: { id: link.id }, data: { active: false } });
        const otherActive = await prisma.supplierProduct.count({ where: { productId: link.productId, active: true } });
        if (!otherActive) await prisma.product.update({ where: { id: link.productId }, data: { status: 'DRAFT', stockQuantity: 0 } });
      }
    }

    const status = errors ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED';
    const message = `${productsUpdated} updated, ${priceUpdates} repriced, ${stockUpdates} stock changes, ${skipped} skipped, ${errors} errors`;
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status, productsSeen, productsUpdated, stockUpdates, errorMessage: errors ? message : null, finishedAt: new Date() } });
    await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { lastSyncAt: new Date(), lastSyncStatus: status, lastSyncMessage: message, ...(options.leaseOwner ? {} : { syncLeaseUntil: null, syncLeaseOwner: null }) } });
    return { runId: run.id, status, productsSeen, productsUpdated, stockUpdates, priceUpdates, skipped, errors, completedCatalog, dryRun: Boolean(options.dryRun), sample };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown Vinyasa sync failure';
    await prisma.supplierSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', productsSeen, productsUpdated, stockUpdates, errorMessage: message, finishedAt: new Date() } }).catch(() => undefined);
    await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { lastSyncAt: new Date(), lastSyncStatus: 'FAILED', lastSyncMessage: message, ...(options.leaseOwner ? {} : { syncLeaseUntil: null, syncLeaseOwner: null }) } }).catch(() => undefined);
    throw error;
  }
}


let backgroundImportRunning = false;

export async function startVinyasaImportJob(maxProducts?: number) {
  const { supplier, config } = await ensureVinyasaSupplier();
  if (!vinyasaConfigured()) throw new HttpError(503, 'Set VINYASA_API_KEY before starting the Vinyasa catalogue import.');
  if (!['MAJOR', 'MINOR'].includes(config.supplierMoneyUnit)) throw new HttpError(409, 'Confirm Vinyasa supplier money units before importing products.');
  if (config.importJobStatus === 'RUNNING') return { started: false, status: config.importJobStatus, processed: config.importJobProcessed };
  const ceiling = Math.min(MAX_VINYASA_IMPORT_PRODUCTS, Math.max(1, Math.round(maxProducts ?? config.maxImportProducts)));
  const startedAt = new Date();
  await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: {
    maxImportProducts: ceiling,
    importJobStatus: 'RUNNING',
    importJobMode: 'FULL',
    importJobPage: 1,
    importJobCursor: null,
    importJobProcessed: 0,
    importJobErrors: 0,
    importJobStartedAt: startedAt,
    importJobUpdatedAt: startedAt,
  } });
  setImmediate(() => void resumeVinyasaImportJob().catch(error => console.error('Vinyasa background import failed', error)));
  return { started: true, status: 'RUNNING', maxProducts: ceiling };
}

export async function resumeVinyasaImportJob() {
  if (backgroundImportRunning) return { resumed: false, reason: 'Background importer is already running in this process.' };
  const { supplier, config } = await ensureVinyasaSupplier();
  if (config.importJobStatus !== 'RUNNING') return { resumed: false, status: config.importJobStatus };
  const remaining = Math.max(0, config.maxImportProducts - config.importJobProcessed);
  if (!remaining) {
    await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { importJobStatus: 'LIMIT_REACHED', importJobUpdatedAt: new Date() } });
    return { resumed: false, status: 'LIMIT_REACHED' };
  }
  const owner = await acquireVinyasaSyncLease();
  if (!owner) return { resumed: false, reason: 'A Vinyasa sync lease is already active.' };
  backgroundImportRunning = true;
  try {
    if (config.importJobMode === 'IMAGES') {
      const batchSize = Math.min(env.VINYASA_IMAGE_REPAIR_BATCH_PRODUCTS, remaining);
      const result = await repairVinyasaMissingImagesBatch({ limit: batchSize, afterId: config.importJobCursor ?? undefined });
      const processed = config.importJobProcessed + result.scanned;
      const errors = config.importJobErrors + result.errors;
      const finished = result.completed || processed >= config.maxImportProducts;
      const status = result.completed ? (errors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : finished ? 'LIMIT_REACHED' : 'RUNNING';
      const message = result.completed
        ? 'Image repair complete: ' + result.repaired + ' repaired in the final batch; ' + result.noSupplierImage + ' had no supplier image; ' + errors + ' total errors.'
        : status === 'LIMIT_REACHED'
          ? 'Image repair stopped at configured safety limit after ' + processed + ' missing-image products.'
          : 'Image repair running: ' + processed + ' missing-image products checked; last batch repaired ' + result.repaired + '.';
      await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: {
        importJobStatus: status,
        importJobCursor: result.nextCursor,
        importJobProcessed: processed,
        importJobErrors: errors,
        importJobUpdatedAt: new Date(),
        lastSyncMessage: message,
      } });
      if (status === 'RUNNING') {
        setTimeout(() => void resumeVinyasaImportJob().catch(error => console.error('Vinyasa background image repair continuation failed', error)), 1000);
      }
      return { resumed: true, status, result };
    }

    const result = await syncVinyasaCatalog({
      mode: 'FULL',
      maxProducts: remaining,
      startPage: config.importJobPage,
      startCursor: config.importJobCursor ?? undefined,
      progressSupplierId: supplier.id,
      progressBaseProcessed: config.importJobProcessed,
      progressBaseErrors: config.importJobErrors,
      jobStartedAt: config.importJobStartedAt ?? new Date(),
      leaseOwner: owner,
    });
    const latest = await prisma.supplierIntegrationConfig.findUniqueOrThrow({ where: { supplierId: supplier.id } });
    const status = result.completedCatalog ? (latest.importJobErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : 'LIMIT_REACHED';
    await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { importJobStatus: status, importJobUpdatedAt: new Date() } });
    return { resumed: true, status, result };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown Vinyasa import failure';
    await prisma.supplierIntegrationConfig.update({ where: { supplierId: supplier.id }, data: { importJobStatus: 'FAILED', importJobUpdatedAt: new Date(), lastSyncMessage: message } }).catch(() => undefined);
    throw error;
  } finally {
    backgroundImportRunning = false;
    await releaseVinyasaSyncLease(owner).catch(() => undefined);
  }
}

export async function repriceAllVinyasaProducts() {
  const { supplier, config } = await ensureVinyasaSupplier();
  const links = await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, active: true }, include: { product: true } });
  let updated = 0;
  const rows: Array<{ id: string; sku: string; previousPriceCents: number; price: VinyasaPriceDecision }> = [];
  for (const link of links) {
    if (!link.autoPrice || link.product.sourceType !== 'DROPSHIP') continue;
    const row = normalizeVinyasaProduct(link.rawData, config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR');
    const normalized = row ?? {
      supplierProductId: link.supplierProductId,
      supplierSku: link.supplierSku ?? link.product.sku,
      name: link.product.name,
      description: link.product.description,
      categoryName: 'Vinyasa Parts', categorySlug: 'vinyasa-parts', costCents: link.costCents,
      suggestedRetailCents: link.suggestedRetailCents ?? undefined, shippingCents: link.shippingCents,
      currency: link.currency, stock: link.stock ?? 0, stockKnown: link.stock != null, images: [], fitments: [], isUniversal: link.product.isUniversal,
      requiresFitment: link.product.requiresFitment, taxable: link.product.taxable, raw: {},
    } satisfies VinyasaNormalizedProduct;
    const decision = await priceDecision({ supplierId: supplier.id, categoryId: link.product.categoryId, row: normalized, config, link });
    if (decision.priceCents === link.product.priceCents) continue;
    const previousPriceCents = link.product.priceCents;
    await prisma.$transaction([
      prisma.product.update({ where: { id: link.productId }, data: { priceCents: decision.priceCents } }),
      prisma.supplierProduct.update({ where: { id: link.id }, data: { lastPriceAppliedAt: new Date() } }),
    ]);
    await processProductAlerts({ productId: link.productId, previousPriceCents, newPriceCents: decision.priceCents }).catch(() => undefined);
    updated += 1;
    if (rows.length < 100) rows.push({ id: link.id, sku: link.product.sku, previousPriceCents, price: decision });
  }
  return { updated, rows };
}

export async function vinyasaPricingRows(take = 300) {
  const { supplier, config } = await ensureVinyasaSupplier();
  const links = await prisma.supplierProduct.findMany({
    where: { supplierId: supplier.id },
    include: { product: true },
    orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    take: Math.min(1000, Math.max(1, take)),
  });
  return Promise.all(links.map(async link => {
    const normalized = normalizeVinyasaProduct(link.rawData, config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR') ?? {
      supplierProductId: link.supplierProductId,
      supplierSku: link.supplierSku ?? link.product.sku,
      name: link.product.name,
      description: link.product.description,
      categoryName: 'Vinyasa Parts', categorySlug: 'vinyasa-parts', costCents: link.costCents,
      suggestedRetailCents: link.suggestedRetailCents ?? undefined, shippingCents: link.shippingCents,
      currency: link.currency, stock: link.stock ?? 0, stockKnown: link.stock != null, images: [], fitments: [], isUniversal: link.product.isUniversal,
      requiresFitment: link.product.requiresFitment, taxable: link.product.taxable, raw: {},
    } satisfies VinyasaNormalizedProduct;
    const decision = await priceDecision({ supplierId: supplier.id, categoryId: link.product.categoryId, row: normalized, config, link });
    return {
      id: link.id,
      supplierProductId: link.supplierProductId,
      supplierSku: link.supplierSku,
      costCents: link.costCents,
      shippingCents: link.shippingCents,
      suggestedRetailCents: link.suggestedRetailCents,
      currentPriceCents: link.product.priceCents,
      currency: link.currency,
      stock: link.stock,
      availableStock: link.availableStock,
      active: link.active,
      autoPrice: link.autoPrice,
      markupOverridePercent: link.markupOverridePercent,
      retailOverrideCents: link.retailOverrideCents,
      recommended: decision,
      product: { id: link.product.id, sku: link.product.sku, name: link.product.name, status: link.product.status },
    };
  }));
}

export async function updateVinyasaProductPricing(linkId: string, input: { autoPrice?: boolean; markupOverridePercent?: number | null; retailOverrideCents?: number | null; applyNow?: boolean }) {
  const { supplier, config } = await ensureVinyasaSupplier();
  const link = await prisma.supplierProduct.findFirst({ where: { id: linkId, supplierId: supplier.id }, include: { product: true } });
  if (!link) throw new HttpError(404, 'Vinyasa product link not found');
  const updated = await prisma.supplierProduct.update({ where: { id: link.id }, data: {
    autoPrice: input.autoPrice,
    markupOverridePercent: input.markupOverridePercent,
    retailOverrideCents: input.retailOverrideCents,
  } });
  if (!input.applyNow) return { link: updated };
  const normalized = normalizeVinyasaProduct(link.rawData, config.supplierMoneyUnit === 'MINOR' ? 'MINOR' : 'MAJOR') ?? {
    supplierProductId: link.supplierProductId, supplierSku: link.supplierSku ?? link.product.sku, name: link.product.name,
    description: link.product.description, categoryName: 'Vinyasa Parts', categorySlug: 'vinyasa-parts', costCents: link.costCents,
    suggestedRetailCents: link.suggestedRetailCents ?? undefined, shippingCents: link.shippingCents, currency: link.currency, stock: link.stock ?? 0, stockKnown: link.stock != null,
    images: [], fitments: [], isUniversal: link.product.isUniversal, requiresFitment: link.product.requiresFitment, taxable: link.product.taxable, raw: {},
  } satisfies VinyasaNormalizedProduct;
  const decision = await priceDecision({ supplierId: supplier.id, categoryId: link.product.categoryId, row: normalized, config, link: updated });
  const previousPriceCents = link.product.priceCents;
  await prisma.$transaction([
    prisma.product.update({ where: { id: link.productId }, data: { priceCents: decision.priceCents } }),
    prisma.supplierProduct.update({ where: { id: link.id }, data: { lastPriceAppliedAt: new Date() } }),
  ]);
  if (previousPriceCents !== decision.priceCents) await processProductAlerts({ productId: link.productId, previousPriceCents, newPriceCents: decision.priceCents }).catch(() => undefined);
  return { link: updated, decision };
}

function orderIdFrom(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined;
  const value = record.orderId ?? record.order_id ?? record.id ?? nested?.orderId ?? nested?.order_id ?? nested?.id;
  return value == null ? undefined : String(value);
}

function orderStatusFrom(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined;
  return String(record.status ?? record.orderStatus ?? record.order_status ?? nested?.status ?? '').toLowerCase();
}

function trackingFrom(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : record;
  const tracking = data.tracking && typeof data.tracking === 'object' && !Array.isArray(data.tracking) ? data.tracking as Record<string, unknown> : data;
  return {
    number: tracking.trackingNumber ?? tracking.tracking_number ?? tracking.number,
    url: tracking.trackingUrl ?? tracking.tracking_url ?? tracking.url,
    carrier: tracking.carrier ?? tracking.shippingCarrier ?? tracking.shipping_carrier,
  };
}

async function submitConfiguredOrderPayload(path: string, reference: string, payload: unknown) {
  const headers = { 'Idempotency-Key': reference, 'X-Idempotency-Key': reference };
  return requestVinyasa(path, { method: 'POST', headers, body: JSON.stringify(payload) });
}

export class VinyasaSupplierAdapter implements SupplierAdapter {
  constructor(private readonly supplier: Pick<Supplier, 'id' | 'code' | 'baseUrl'>) {}

  async submitOrder(input: SubmitSupplierOrderInput): Promise<SubmitSupplierOrderResult> {
    const { config } = await ensureVinyasaSupplier();
    if (!config.orderSubmissionEnabled) throw new HttpError(503, 'Automatic Vinyasa order submission is disabled until the authenticated order API contract has been verified.');
    const paymentMode = config.paymentMode || env.VINYASA_PAYMENT_MODE;
    const camelPayload = {
      reference: input.reference,
      externalReference: input.reference,
      paymentMethod: paymentMode,
      items: input.items.map(item => ({ productId: item.supplierProductId, sku: item.sku ?? undefined, quantity: item.quantity })),
      shippingAddress: input.shippingAddress,
    };
    const snakePayload = {
      reference: input.reference,
      external_reference: input.reference,
      payment_method: paymentMode,
      items: input.items.map(item => ({ product_id: item.supplierProductId, sku: item.sku ?? undefined, quantity: item.quantity })),
      shipping_address: {
        first_name: input.shippingAddress.firstName,
        last_name: input.shippingAddress.lastName,
        address1: input.shippingAddress.line1,
        address2: input.shippingAddress.line2,
        city: input.shippingAddress.city,
        state: input.shippingAddress.state,
        postal_code: input.shippingAddress.postalCode,
        country: input.shippingAddress.country,
        phone: input.shippingAddress.phone,
      },
    };
    const orderPayload = config.orderPayloadStyle === 'SNAKE' ? snakePayload : camelPayload;
    const payload = await submitConfiguredOrderPayload(config.ordersPath, input.reference, orderPayload);
    const supplierOrderId = orderIdFrom(payload);
    if (!supplierOrderId) throw new HttpError(502, 'Vinyasa accepted the request but did not return an order ID. Review the configured Vinyasa order endpoint/payload.');
    const status = orderStatusFrom(payload);
    return { supplierOrderId, status: ['accepted', 'paid', 'confirmed'].includes(status) ? 'accepted' : 'processing', raw: payload };
  }

  async getTracking(supplierOrderId: string): Promise<SupplierTrackingResult> {
    const { config } = await ensureVinyasaSupplier();
    const path = config.orderStatusPathTemplate.replace('{id}', encodeURIComponent(supplierOrderId));
    const payload = await requestVinyasa(path, { method: 'GET' });
    const status = orderStatusFrom(payload);
    const tracking = trackingFrom(payload);
    const normalized: SupplierTrackingResult['status'] = ['delivered', 'complete', 'completed'].includes(status) ? 'delivered'
      : ['shipped', 'in_transit', 'in-transit'].includes(status) ? 'shipped'
      : ['cancelled', 'canceled', 'voided'].includes(status) ? 'cancelled'
      : 'processing';
    return {
      status: normalized,
      trackingNumber: tracking.number == null ? undefined : String(tracking.number),
      trackingUrl: tracking.url == null ? undefined : String(tracking.url),
      carrier: tracking.carrier == null ? undefined : String(tracking.carrier),
      raw: payload,
    };
  }
}


/** Poll Vinyasa for shipment/tracking updates; repeated runs are idempotent. */
export async function syncVinyasaTracking(limit = 200) {
  const { supplier } = await ensureVinyasaSupplier();
  if (!vinyasaConfigured()) throw new HttpError(503, 'Set VINYASA_API_KEY before syncing Vinyasa tracking.');
  const fulfillments = await prisma.fulfillment.findMany({
    where: { supplierId: supplier.id, supplierOrderId: { not: null }, status: { in: ['SUBMITTED', 'ACCEPTED', 'PROCESSING', 'SHIPPED'] } },
    include: { order: { select: { id: true, orderNumber: true, userId: true, email: true } } },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(1000, Math.max(1, Math.round(limit))),
  });
  const adapter = new VinyasaSupplierAdapter(supplier);
  let checked = 0, updated = 0, errors = 0;
  const sample: Array<Record<string, unknown>> = [];
  for (const fulfillment of fulfillments) {
    checked += 1;
    try {
      const tracking = await adapter.getTracking(fulfillment.supplierOrderId!);
      const mappedStatus = tracking.status === 'shipped' ? 'SHIPPED'
        : tracking.status === 'delivered' ? 'DELIVERED'
        : tracking.status === 'cancelled' ? 'CANCELLED'
        : 'PROCESSING';
      const nextStatus = fulfillment.status === 'SHIPPED' && mappedStatus === 'PROCESSING' ? 'SHIPPED' : mappedStatus;
      const transitioned = nextStatus !== fulfillment.status
        || Boolean(tracking.trackingNumber && tracking.trackingNumber !== fulfillment.trackingNumber)
        || Boolean(tracking.trackingUrl && tracking.trackingUrl !== fulfillment.trackingUrl);
      if (transitioned) {
        await prisma.fulfillment.update({
          where: { id: fulfillment.id },
          data: {
            status: nextStatus,
            trackingNumber: tracking.trackingNumber ?? fulfillment.trackingNumber,
            trackingUrl: tracking.trackingUrl ?? fulfillment.trackingUrl,
            carrier: tracking.carrier ?? fulfillment.carrier,
            shippedAt: nextStatus === 'SHIPPED' && !fulfillment.shippedAt ? new Date() : fulfillment.shippedAt,
            deliveredAt: nextStatus === 'DELIVERED' && !fulfillment.deliveredAt ? new Date() : fulfillment.deliveredAt,
            rawResponse: (tracking.raw ?? {}) as Prisma.InputJsonValue,
            errorMessage: null,
          },
        });
        await recomputeOrderFulfillmentStatus(fulfillment.orderId);
        updated += 1;
        if ((nextStatus === 'SHIPPED' || nextStatus === 'DELIVERED') && nextStatus !== fulfillment.status) {
          const label = nextStatus === 'SHIPPED' ? 'shipped' : 'delivered';
          if (fulfillment.order.userId) await createNotification({ userId: fulfillment.order.userId, type: 'SHIPPING', title: nextStatus === 'SHIPPED' ? 'Order shipped' : 'Order delivered', body: `Order ${fulfillment.order.orderNumber} is ${label}.`, link: `#/order/${fulfillment.order.orderNumber}` }).catch(() => undefined);
          await sendEmail({ to: fulfillment.order.email, subject: `SANDMAN order ${fulfillment.order.orderNumber}: ${label}`, text: `Your order ${fulfillment.order.orderNumber} is ${label}.${tracking.trackingNumber ? ` Tracking: ${tracking.trackingNumber}` : ''}`, type: 'SHIPPING' }).catch(() => undefined);
        }
      }
      if (sample.length < 50) sample.push({ fulfillmentId: fulfillment.id, supplierOrderId: fulfillment.supplierOrderId, status: nextStatus, trackingNumber: tracking.trackingNumber ?? null });
    } catch (error) {
      errors += 1;
      if (sample.length < 50) sample.push({ fulfillmentId: fulfillment.id, error: error instanceof Error ? error.message : 'Tracking refresh failed' });
    }
  }
  return { checked, updated, errors, sample };
}

export async function acquireVinyasaSyncLease(owner = randomUUID()) {
  const { supplier } = await ensureVinyasaSupplier();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + env.VINYASA_SYNC_LEASE_MINUTES * 60_000);
  const claimed = await prisma.supplierIntegrationConfig.updateMany({
    where: { supplierId: supplier.id, OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] },
    data: { syncLeaseUntil: leaseUntil, syncLeaseOwner: owner },
  });
  return claimed.count === 1 ? owner : null;
}

export async function releaseVinyasaSyncLease(owner: string) {
  const { supplier } = await ensureVinyasaSupplier();
  await prisma.supplierIntegrationConfig.updateMany({ where: { supplierId: supplier.id, syncLeaseOwner: owner }, data: { syncLeaseUntil: null, syncLeaseOwner: null } });
}
