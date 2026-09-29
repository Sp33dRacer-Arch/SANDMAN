#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = {
  env: 'src/config/env.ts',
  vinyasa: 'src/services/vinyasa.service.ts',
  experience: 'src/modules/experience/experience.routes.ts',
  inventory: 'src/services/supplier-inventory.service.ts',
};
const original = new Map();
const next = new Map();
for (const [key, rel] of Object.entries(files)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Required SANDMAN file is missing: ${rel}`);
  const text = fs.readFileSync(file, 'utf8');
  original.set(key, text);
  next.set(key, text.replace(/\r\n/g, '\n'));
}
const changes = [];
function replaceOne(key, before, after, label) {
  let text = next.get(key);
  if (text.includes(after)) return;
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`Could not safely patch ${label}; expected one marker, found ${count}.`);
  next.set(key, text.replace(before, after));
  changes.push(label);
}
function replaceAllExact(key, before, after, expected, label) {
  let text = next.get(key);
  if (!text.includes(before) && text.includes(after)) return;
  const count = text.split(before).length - 1;
  if (count !== expected) throw new Error(`Could not safely patch ${label}; expected ${expected} markers, found ${count}.`);
  next.set(key, text.split(before).join(after));
  changes.push(label);
}
function replaceIfPresent(key, before, after, label) {
  let text = next.get(key);
  if (text.includes(after)) return;
  const count = text.split(before).length - 1;
  if (count === 0) return;
  if (count !== 1) throw new Error(`Could not safely repair ${label}; expected at most one marker, found ${count}.`);
  next.set(key, text.replace(before, after));
  changes.push(label);
}

function functionWindowByName(key, functionName, { optional = false } = {}) {
  const text = next.get(key);
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^(?:export\\s+)?async\\s+function\\s+${escaped}\\s*\\(`, 'm'),
    new RegExp(`^(?:export\\s+)?function\\s+${escaped}\\s*\\(`, 'm'),
    new RegExp(`^(?:export\\s+)?const\\s+${escaped}\\s*=\\s*async\\b`, 'm'),
  ];
  let match = null;
  for (const pattern of patterns) {
    const candidate = pattern.exec(text);
    if (candidate && (!match || candidate.index < match.index)) match = candidate;
  }
  if (!match) {
    if (optional) return null;
    throw new Error(`Could not locate function ${functionName} for structural patching.`);
  }
  const start = match.index;
  const nextDecl = /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=/gm;
  nextDecl.lastIndex = start + match[0].length;
  let end = text.length;
  let candidate;
  while ((candidate = nextDecl.exec(text))) {
    if (candidate.index > start) { end = candidate.index; break; }
  }
  return { text, start, end, body: text.slice(start, end), functionName };
}

function ensureLineAfterInFunction(key, functionName, anchorRegex, line, label, { optionalFunction = false } = {}) {
  const window = functionWindowByName(key, functionName, { optional: optionalFunction });
  if (!window) return false;
  const { text, start, body } = window;
  if (body.includes(line.trim())) return true;
  const match = body.match(anchorRegex);
  if (!match || match.index == null) throw new Error(`Could not safely patch ${label}; structural anchor was not found in ${functionName}.`);
  const insertAt = start + match.index + match[0].length;
  next.set(key, text.slice(0, insertAt) + `\n${line}` + text.slice(insertAt));
  changes.push(label);
  return true;
}

function replaceLineInFunction(key, functionName, lineRegex, replacement, label, { optional = false, optionalFunction = false } = {}) {
  const window = functionWindowByName(key, functionName, { optional: optionalFunction });
  if (!window) return false;
  const { text, start, body } = window;
  if (body.includes(replacement.trim())) return true;
  const match = body.match(lineRegex);
  if (!match || match.index == null) {
    if (optional) return false;
    throw new Error(`Could not safely patch ${label}; structural line was not found in ${functionName}.`);
  }
  const rest = body.slice(match.index + match[0].length);
  if (rest.match(lineRegex)) throw new Error(`Could not safely patch ${label}; structural line matched more than once.`);
  const from = start + match.index;
  const to = from + match[0].length;
  next.set(key, text.slice(0, from) + replacement + text.slice(to));
  changes.push(label);
  return true;
}

// 1) Default-on lean storage guardrails. No Railway variable is required.
{
  let text = next.get('env');
  if (!text.includes('VINYASA_LEAN_STORAGE_MODE:')) {
    const anchor = /^  VINYASA_IMAGE_REPAIR_BATCH_PRODUCTS:.*,$/m;
    const match = text.match(anchor);
    if (!match || match.index == null) throw new Error('Could not safely add lean storage environment defaults; VINYASA_IMAGE_REPAIR_BATCH_PRODUCTS anchor was not found.');
    const insertAt = match.index + match[0].length;
    const addition = `
  VINYASA_LEAN_STORAGE_MODE: booleanFromEnv.default(true),
  VINYASA_DB_SIZE_GUARD_MB: z.coerce.number().int().min(100).max(10000).default(250),
  VINYASA_LEAN_BATCH_PRODUCTS: z.coerce.number().int().min(50).max(2000).default(500),`;
    next.set('env', text.slice(0, insertAt) + addition + text.slice(insertAt));
    changes.push('lean Vinyasa storage environment defaults');
  }
}

// 2) Never persist supplier response payloads. Existing pricing/image-repair code
// already falls back to normalized SupplierProduct/Product columns or fetches
// product detail from Vinyasa when rawData is empty.
replaceAllExact('vinyasa',
'        rawData: row.raw as Prisma.InputJsonValue,',
'        rawData: Prisma.DbNull,',
3,
'lean SupplierProduct rawData persistence');

// 3) Dynamic storefront SEO already generates stronger metadata. Stop writing
// duplicated importer-generated SEO into every Product row.
replaceAllExact('vinyasa',
`    shippingMinDays: row.leadTimeDays,
    shippingMaxDays: row.leadTimeDays == null ? undefined : row.leadTimeDays + 7,
    seoTitle: \`${'${row.name}'}${'${row.brand ? ` | ${row.brand}` : \'\'}'} — SANDMAN\`.slice(0, 180),
    seoDescription: (row.shortDesc || row.description).slice(0, 300),`,
`    shippingMinDays: row.leadTimeDays,
    shippingMaxDays: row.leadTimeDays == null ? undefined : row.leadTimeDays + 7,`,
1,
'stop duplicate importer-generated SEO persistence');

// Clear only exact legacy Vinyasa-generated SEO as already-synced products are
// touched; manual/custom SEO remains authoritative.
replaceIfPresent('vinyasa',
`  const buyerStock = safeStock(row);
  const publishStatus = config.autoPublish && row.stockKnown && buyerStock > 0 ? 'ACTIVE' : 'DRAFT';

  const commonData = {`,
`  const buyerStock = safeStock(row);
  const publishStatus = config.autoPublish && row.stockKnown && buyerStock > 0 ? 'ACTIVE' : 'DRAFT';
  const normalizeLegacySeo = (value: string | null | undefined) => String(value ?? '').replace(/\\u00e2\\u20ac\\u201d/g, '\\u2014').replace(/\\s+/g, ' ').trim();
  const legacySeoTitle = \`${'${row.name}'}${'${row.brand ? ` | ${row.brand}` : \'\'}'} — SANDMAN\`.slice(0, 180);
  const legacySeoDescription = String(row.shortDesc || row.description || '').slice(0, 300);
  const clearLegacySeo = product?.sourceType === 'DROPSHIP' ? {
    ...(product.seoTitle && normalizeLegacySeo(product.seoTitle) === normalizeLegacySeo(legacySeoTitle) ? { seoTitle: null } : {}),
    ...(product.seoDescription && normalizeLegacySeo(product.seoDescription) === normalizeLegacySeo(legacySeoDescription) ? { seoDescription: null } : {}),
  } : {};

  const commonData = {`,
'legacy Vinyasa SEO cleanup on touch');
replaceIfPresent('vinyasa',
`      data: { ...contentData, ...(config.autoPublish && product.status === 'DRAFT' && row.stockKnown && buyerStock > 0 ? { status: 'ACTIVE' as const } : {}), ...(!row.stockKnown ? { stockQuantity: 0 } : {}) },`,
`      data: { ...contentData, ...clearLegacySeo, ...(config.autoPublish && product.status === 'DRAFT' && row.stockKnown && buyerStock > 0 ? { status: 'ACTIVE' as const } : {}), ...(!row.stockKnown ? { stockQuantity: 0 } : {}) },`,
'apply legacy SEO cleanup safely');

// Avoid delete/recreate churn when supplier images or fitment evidence did not change.
replaceOne('vinyasa',
"  if (config.overwriteImages && row.images.length) {\n    await prisma.$transaction(async tx => {\n      await tx.productImage.deleteMany({ where: { productId: product!.id } });\n      await tx.productImage.createMany({\n        data: row.images.map((url, position) => ({ productId: product!.id, url, position, alt: `${row.name}${position ? ` image ${position + 1}` : ''}` })),\n      });\n    });\n  }",
"  if (config.overwriteImages && row.images.length) {\n    const nextImages = [...new Set(row.images)].slice(0, 12).map((url, position) => ({ url, position, alt: `${row.name}${position ? ` image ${position + 1}` : ''}` }));\n    const currentImages = await prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { position: 'asc' }, select: { url: true, position: true, alt: true } });\n    const imagesChanged = currentImages.length !== nextImages.length || nextImages.some((image, index) => currentImages[index]?.url !== image.url || currentImages[index]?.position !== image.position || currentImages[index]?.alt !== image.alt);\n    if (imagesChanged) {\n      await prisma.$transaction(async tx => {\n        await tx.productImage.deleteMany({ where: { productId: product!.id } });\n        await tx.productImage.createMany({ data: nextImages.map(image => ({ productId: product!.id, ...image })) });\n      });\n    }\n  }",
'write-sparse Vinyasa product images');

replaceOne('vinyasa',
"  // Refresh only the Vinyasa-generated, unverified rows. Manual and verified\n  // fitment evidence is never deleted by a supplier synchronization.\n  await prisma.productFitment.deleteMany({\n    where: {\n      productId,\n      source: 'SUPPLIER',\n      verified: false,\n      notes: { startsWith: 'Imported from Vinyasa supplier compatibility data;' },\n    },\n  });\n  await prisma.productFitment.createMany({\n    data: [...ids].map(vehicleVariantId => ({ productId, vehicleVariantId, verified: false, compatibility: 'FITS', source: 'SUPPLIER', notes: VINYASA_SUPPLIER_FITMENT_NOTE })),\n    skipDuplicates: true,\n  });\n  return ids.size;",
"  // Refresh only the Vinyasa-generated, unverified rows. Manual and verified\n  // fitment evidence is never deleted by a supplier synchronization.\n  const existingSupplierFitments = await prisma.productFitment.findMany({\n    where: {\n      productId,\n      source: 'SUPPLIER',\n      verified: false,\n      notes: { startsWith: 'Imported from Vinyasa supplier compatibility data;' },\n    },\n    select: { vehicleVariantId: true },\n  });\n  const existingIds = new Set(existingSupplierFitments.map(item => item.vehicleVariantId));\n  if (existingIds.size === ids.size && [...ids].every(id => existingIds.has(id))) return ids.size;\n  await prisma.productFitment.deleteMany({\n    where: {\n      productId,\n      source: 'SUPPLIER',\n      verified: false,\n      notes: { startsWith: 'Imported from Vinyasa supplier compatibility data;' },\n    },\n  });\n  await prisma.productFitment.createMany({\n    data: [...ids].map(vehicleVariantId => ({ productId, vehicleVariantId, verified: false, compatibility: 'FITS', source: 'SUPPLIER', notes: VINYASA_SUPPLIER_FITMENT_NOTE })),\n    skipDuplicates: true,\n  });\n  return ids.size;",
'write-sparse Vinyasa fitment refresh');

// 4) Database-size guard. pg_database_size is read-only and lets catalogue/image growth
// stop before PostgreSQL consumes the Railway volume again. Stock/price refreshes remain allowed.
{
  let text = next.get('vinyasa');
  if (!text.includes('async function assertVinyasaStorageHeadroom')) {
    const anchor = /^const IMAGE_REPAIR_REQUEST_DELAY_MS\s*=.*;$/m;
    let match = text.match(anchor);
    if (!match || match.index == null) {
      const fallback = /^export const MAX_VINYASA_IMPORT_PRODUCTS\s*=.*;$/m;
      match = text.match(fallback);
    }
    if (!match || match.index == null) throw new Error('Could not safely add PostgreSQL storage guard; Vinyasa constants anchor was not found.');
    const insertAt = match.index + match[0].length;
    const addition = `

async function vinyasaDatabaseSizeMb() {
  const rows = await prisma.$queryRaw<Array<{ bytes: bigint }>>\`SELECT pg_database_size(current_database())::bigint AS bytes\`;
  const bytes = rows[0]?.bytes ?? 0n;
  return Number(bytes) / (1024 * 1024);
}

async function assertVinyasaStorageHeadroom(operation: string) {
  if (!env.VINYASA_LEAN_STORAGE_MODE) return null;
  const sizeMb = await vinyasaDatabaseSizeMb();
  if (sizeMb >= env.VINYASA_DB_SIZE_GUARD_MB) {
    throw new HttpError(507, \`Vinyasa \${operation} stopped by SANDMAN lean-storage guard: database is \${sizeMb.toFixed(1)} MB, at/above the \${env.VINYASA_DB_SIZE_GUARD_MB} MB safety limit. Increase Railway storage or intentionally raise VINYASA_DB_SIZE_GUARD_MB before continuing.\`);
  }
  return sizeMb;
}`;
    next.set('vinyasa', text.slice(0, insertAt) + addition + text.slice(insertAt));
    changes.push('Postgres database-size safety guard');
  }
}

// Remove/repair any older guard that could block stock/price synchronization.
replaceLineInFunction('vinyasa', 'syncVinyasaCatalog', /^\s*if \(!options\.dryRun\) await assertVinyasaStorageHeadroom\(options\.mode === 'STOCK_PRICE'.*$/m,
  "  if (!options.dryRun && options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import');",
  'allow stock/price sync under storage pressure', { optional: true });
replaceLineInFunction('vinyasa', 'syncVinyasaCatalog', /^\s*if \(!options\.dryRun\) await assertVinyasaStorageHeadroom\('stock\/price sync'.*$/m,
  "  if (!options.dryRun && options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import');",
  'remove stock/price storage guard', { optional: true });

// Direct FULL catalogue sync: check once before the run row and again before every fetched page.
ensureLineAfterInFunction('vinyasa', 'syncVinyasaCatalog', /^  const maxProducts\s*=.*;$/m,
  "  if (!options.dryRun && options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import');",
  'pre-sync storage guard');
ensureLineAfterInFunction('vinyasa', 'syncVinyasaCatalog', /^    while \(productsSeen < maxProducts\) \{$/m,
  "      if (!options.dryRun && options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import');",
  'per-page storage guard');

// Background catalogue jobs support both SANDMAN worker generations:
// - newer startVinyasaCatalogJob/processVinyasaCatalogJobBatch
// - legacy startVinyasaImportJob/resumeVinyasaImportJob
// FULL catalogue growth is guarded; STOCK_PRICE jobs are never blocked.
{
  const modernStarter = functionWindowByName('vinyasa', 'startVinyasaCatalogJob', { optional: true });
  const legacyStarter = functionWindowByName('vinyasa', 'startVinyasaImportJob', { optional: true });
  if (!modernStarter && !legacyStarter) throw new Error('Could not locate a supported Vinyasa background import starter (startVinyasaCatalogJob or startVinyasaImportJob).');

  if (modernStarter) {
    const safeLine = "  if ((input.mode ?? 'FULL') !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog job');";
    if (!modernStarter.body.includes(safeLine)) {
      replaceLineInFunction('vinyasa', 'startVinyasaCatalogJob', /^\s*await assertVinyasaStorageHeadroom\('catalog job'\);$/m, safeLine, 'repair modern catalog-job stock/price guard', { optional: true });
      const refreshed = functionWindowByName('vinyasa', 'startVinyasaCatalogJob').body;
      if (!refreshed.includes(safeLine)) {
        ensureLineAfterInFunction('vinyasa', 'startVinyasaCatalogJob', /^  if \(config\.importJobStatus === 'RUNNING'\).*;$/m, safeLine, 'modern catalog-job storage guard');
      }
    }
  }

  if (legacyStarter) {
    const legacyLine = "  await assertVinyasaStorageHeadroom('catalog job');";
    if (!legacyStarter.body.includes(legacyLine)) {
      ensureLineAfterInFunction('vinyasa', 'startVinyasaImportJob', /^  if \(config\.importJobStatus === 'RUNNING'\).*;$/m, legacyLine, 'legacy catalog-job storage guard');
    }
  }

  const batchLine = "  if (config.importJobMode !== 'STOCK_PRICE' && config.importJobMode !== 'IMAGES') await assertVinyasaStorageHeadroom('catalog job batch');";
  const modernBatch = functionWindowByName('vinyasa', 'processVinyasaCatalogJobBatch', { optional: true });
  const legacyBatch = functionWindowByName('vinyasa', 'resumeVinyasaImportJob', { optional: true });
  if (!modernBatch && !legacyBatch) throw new Error('Could not locate a supported Vinyasa background batch worker (processVinyasaCatalogJobBatch or resumeVinyasaImportJob).');
  if (modernBatch && !modernBatch.body.includes(batchLine)) {
    ensureLineAfterInFunction('vinyasa', 'processVinyasaCatalogJobBatch', /^  const remaining\s*=.*;$/m, batchLine, 'modern catalog-job per-batch storage guard');
  }
  if (legacyBatch && !legacyBatch.body.includes(batchLine)) {
    ensureLineAfterInFunction('vinyasa', 'resumeVinyasaImportJob', /^  const remaining\s*=.*;$/m, batchLine, 'legacy catalog-job per-batch storage guard');
  }
}

// Image repair always grows/changes product media, so guard it regardless of money-unit helper shape.
ensureLineAfterInFunction('vinyasa', 'repairVinyasaMissingImagesBatch', /^  const moneyUnit\s*=.*;$/m,
  "  await assertVinyasaStorageHeadroom('image repair batch');",
  'image-repair per-batch storage guard');
ensureLineAfterInFunction('vinyasa', 'startVinyasaImageRepairJob', /^  if \(config\.importJobStatus === 'RUNNING'\).*;$/m,
  "  await assertVinyasaStorageHeadroom('image repair');",
  'image-repair storage guard');

// Frequent stock/price refreshes should stay write-sparse without letting per-product sync freshness become indefinitely stale.
replaceIfPresent('vinyasa',
`            const previousStock = existing.availableStock;
            const categoryId = existing.product.categoryId;
            const decision = await priceDecision({ supplierId: supplier.id, categoryId, row, config, link: existing });
            const priceChanged = existing.autoPrice && existing.product.priceCents !== decision.priceCents;
            const supplierStockChanged = existing.stock !== buyerStock;
            const supplierMetadataChanged = existing.costCents !== row.costCents
              || existing.shippingCents !== row.shippingCents
              || existing.suggestedRetailCents !== (row.suggestedRetailCents ?? null)
              || existing.currency !== row.currency.toUpperCase()
              || existing.leadTimeDays !== (row.leadTimeDays ?? null)
              || existing.warehouseCountry !== (row.warehouseCountry ?? null)
              || existing.active !== row.stockKnown
              || existing.rawData != null;
            const productStockChanged = existing.product.stockQuantity !== buyerStock;
            let newAvailableStock = previousStock;
            await prisma.$transaction(async tx => {
              if (supplierMetadataChanged || priceChanged) {
                await tx.supplierProduct.update({ where: { id: existing.id }, data: {
                  costCents: row.costCents,
                  shippingCents: row.shippingCents,
                  suggestedRetailCents: row.suggestedRetailCents,
                  currency: row.currency.toUpperCase(),
                  leadTimeDays: row.leadTimeDays,
                  warehouseCountry: row.warehouseCountry,
                  active: row.stockKnown,
                  lastSyncedAt: new Date(),
                  rawData: Prisma.DbNull,
                  ...(priceChanged ? { lastPriceAppliedAt: new Date() } : {}),
                } });
              }
              if (supplierStockChanged) newAvailableStock = await setSupplierReportedStock(tx, existing.id, buyerStock);
              if (productStockChanged || priceChanged) {
                await tx.product.update({ where: { id: existing.productId }, data: {
                  ...(productStockChanged ? { stockQuantity: buyerStock } : {}),
                  ...(priceChanged ? { priceCents: decision.priceCents } : {}),
                } });
              }
            });
            if (previousStock !== newAvailableStock) {
              stockUpdates += 1;
              await processProductAlerts({ productId: existing.productId, previousStock, newStock: newAvailableStock }).catch(() => undefined);
            }`,
`            const previousStock = existing.availableStock;
            const categoryId = existing.product.categoryId;
            const decision = await priceDecision({ supplierId: supplier.id, categoryId, row, config, link: existing });
            const priceChanged = existing.autoPrice && existing.product.priceCents !== decision.priceCents;
            const supplierStockChanged = existing.stock !== buyerStock;
            const supplierMetadataChanged = existing.costCents !== row.costCents
              || existing.shippingCents !== row.shippingCents
              || existing.suggestedRetailCents !== (row.suggestedRetailCents ?? null)
              || existing.currency !== row.currency.toUpperCase()
              || existing.leadTimeDays !== (row.leadTimeDays ?? null)
              || existing.warehouseCountry !== (row.warehouseCountry ?? null)
              || existing.active !== row.stockKnown
              || existing.rawData != null;
            const productStockChanged = existing.product.stockQuantity !== buyerStock;
            const syncHeartbeatDue = !existing.lastSyncedAt || existing.lastSyncedAt.getTime() < Date.now() - 6 * 60 * 60 * 1000;
            let newAvailableStock = previousStock;
            await prisma.$transaction(async tx => {
              if (supplierMetadataChanged || priceChanged || syncHeartbeatDue) {
                await tx.supplierProduct.update({ where: { id: existing.id }, data: {
                  ...(supplierMetadataChanged ? {
                    costCents: row.costCents,
                    shippingCents: row.shippingCents,
                    suggestedRetailCents: row.suggestedRetailCents,
                    currency: row.currency.toUpperCase(),
                    leadTimeDays: row.leadTimeDays,
                    warehouseCountry: row.warehouseCountry,
                    active: row.stockKnown,
                    rawData: Prisma.DbNull,
                  } : {}),
                  lastSyncedAt: new Date(),
                  ...(priceChanged ? { lastPriceAppliedAt: new Date() } : {}),
                } });
              }
              if (supplierStockChanged) newAvailableStock = await setSupplierReportedStock(tx, existing.id, buyerStock);
              if (productStockChanged || priceChanged) {
                await tx.product.update({ where: { id: existing.productId }, data: {
                  ...(productStockChanged ? { stockQuantity: buyerStock } : {}),
                  ...(priceChanged ? { priceCents: decision.priceCents } : {}),
                } });
              }
            });
            if (previousStock !== newAvailableStock) {
              stockUpdates += 1;
              await processProductAlerts({ productId: existing.productId, previousStock, newStock: newAvailableStock }).catch(() => undefined);
            }`,
'bounded Vinyasa lastSyncedAt heartbeat');
replaceOne('vinyasa',
`            const previousStock = existing.availableStock;
            const categoryId = existing.product.categoryId;
            const decision = await priceDecision({ supplierId: supplier.id, categoryId, row, config, link: existing });
            const priceChanged = existing.autoPrice && existing.product.priceCents !== decision.priceCents;
            await prisma.$transaction(async tx => {
              await tx.supplierProduct.update({ where: { id: existing.id }, data: {
                costCents: row.costCents,
                shippingCents: row.shippingCents,
                suggestedRetailCents: row.suggestedRetailCents,
                currency: row.currency.toUpperCase(),
                leadTimeDays: row.leadTimeDays,
                warehouseCountry: row.warehouseCountry,
                active: row.stockKnown,
                lastSyncedAt: new Date(),
                rawData: Prisma.DbNull,
                ...(priceChanged ? { lastPriceAppliedAt: new Date() } : {}),
              } });
              await setSupplierReportedStock(tx, existing.id, buyerStock);
              await tx.product.update({ where: { id: existing.productId }, data: {
                stockQuantity: buyerStock,
                ...(priceChanged ? { priceCents: decision.priceCents } : {}),
              } });
            });
            if (previousStock !== buyerStock) {
              stockUpdates += 1;
              await processProductAlerts({ productId: existing.productId, previousStock, newStock: buyerStock }).catch(() => undefined);
            }`,
`            const previousStock = existing.availableStock;
            const categoryId = existing.product.categoryId;
            const decision = await priceDecision({ supplierId: supplier.id, categoryId, row, config, link: existing });
            const priceChanged = existing.autoPrice && existing.product.priceCents !== decision.priceCents;
            const supplierStockChanged = existing.stock !== buyerStock;
            const supplierMetadataChanged = existing.costCents !== row.costCents
              || existing.shippingCents !== row.shippingCents
              || existing.suggestedRetailCents !== (row.suggestedRetailCents ?? null)
              || existing.currency !== row.currency.toUpperCase()
              || existing.leadTimeDays !== (row.leadTimeDays ?? null)
              || existing.warehouseCountry !== (row.warehouseCountry ?? null)
              || existing.active !== row.stockKnown
              || existing.rawData != null;
            const productStockChanged = existing.product.stockQuantity !== buyerStock;
            const syncHeartbeatDue = !existing.lastSyncedAt || existing.lastSyncedAt.getTime() < Date.now() - 6 * 60 * 60 * 1000;
            let newAvailableStock = previousStock;
            await prisma.$transaction(async tx => {
              if (supplierMetadataChanged || priceChanged || syncHeartbeatDue) {
                await tx.supplierProduct.update({ where: { id: existing.id }, data: {
                  ...(supplierMetadataChanged ? {
                    costCents: row.costCents,
                    shippingCents: row.shippingCents,
                    suggestedRetailCents: row.suggestedRetailCents,
                    currency: row.currency.toUpperCase(),
                    leadTimeDays: row.leadTimeDays,
                    warehouseCountry: row.warehouseCountry,
                    active: row.stockKnown,
                    rawData: Prisma.DbNull,
                  } : {}),
                  lastSyncedAt: new Date(),
                  ...(priceChanged ? { lastPriceAppliedAt: new Date() } : {}),
                } });
              }
              if (supplierStockChanged) newAvailableStock = await setSupplierReportedStock(tx, existing.id, buyerStock);
              if (productStockChanged || priceChanged) {
                await tx.product.update({ where: { id: existing.productId }, data: {
                  ...(productStockChanged ? { stockQuantity: buyerStock } : {}),
                  ...(priceChanged ? { priceCents: decision.priceCents } : {}),
                } });
              }
            });
            if (previousStock !== newAvailableStock) {
              stockUpdates += 1;
              await processProductAlerts({ productId: existing.productId, previousStock, newStock: newAvailableStock }).catch(() => undefined);
            }`,
'sparse unchanged Vinyasa stock/price writes');

// 5) Smaller background batches in lean mode reduce transient WAL growth.
replaceOne('vinyasa',
`    const batchSize = Math.min(env.VINYASA_IMPORT_BATCH_PRODUCTS, remaining);`,
`    const batchSize = Math.min(env.VINYASA_IMPORT_BATCH_PRODUCTS, env.VINYASA_LEAN_STORAGE_MODE ? env.VINYASA_LEAN_BATCH_PRODUCTS : env.VINYASA_IMPORT_BATCH_PRODUCTS, remaining);`,
'lean background import batch size');

// 6) Anonymous product views stay write-free but still validate active product IDs. Logged-in recently
// viewed rows are refreshed at most every six hours and strictly pruned to 50/user.
replaceIfPresent('experience',
`experienceRouter.post('/products/:id/view', optionalAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  if (!req.auth) return res.status(204).send();
  const existing = await prisma.recentlyViewed.findUnique({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, select: { viewedAt: true } });
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  if (!existing || existing.viewedAt.getTime() < sixHoursAgo) {
    const updated = await prisma.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { viewCount: { increment: 1 } } });
    if (!updated.count) throw new HttpError(404, 'Product not found');
    await prisma.recentlyViewed.upsert({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, update: { viewedAt: new Date() }, create: { userId: req.auth.userId, productId: id } });
    const overflow = await prisma.recentlyViewed.findMany({ where: { userId: req.auth.userId }, orderBy: { viewedAt: 'desc' }, skip: 50, select: { id: true }, take: 200 });
    if (overflow.length) await prisma.recentlyViewed.deleteMany({ where: { id: { in: overflow.map(row => row.id) } } });
  }
  res.status(204).send();
}));`,
`experienceRouter.post('/products/:id/view', optionalAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const product = await prisma.product.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  if (!req.auth) return res.status(204).send();
  const existing = await prisma.recentlyViewed.findUnique({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, select: { viewedAt: true } });
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  if (!existing || existing.viewedAt.getTime() < sixHoursAgo) {
    const updated = await prisma.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { viewCount: { increment: 1 } } });
    if (!updated.count) throw new HttpError(404, 'Product not found');
    await prisma.recentlyViewed.upsert({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, update: { viewedAt: new Date() }, create: { userId: req.auth.userId, productId: id } });
  }
  const overflow = await prisma.recentlyViewed.findMany({ where: { userId: req.auth.userId }, orderBy: { viewedAt: 'desc' }, skip: 50, select: { id: true } });
  if (overflow.length) await prisma.recentlyViewed.deleteMany({ where: { id: { in: overflow.map(row => row.id) } } });
  res.status(204).send();
}));`,
'validate anonymous views and strictly cap recent history');
replaceOne('experience',
`experienceRouter.post('/products/:id/view', optionalAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const updated = await prisma.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { viewCount: { increment: 1 } } });
  if (!updated.count) throw new HttpError(404, 'Product not found');
  if (req.auth) await prisma.recentlyViewed.upsert({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, update: { viewedAt: new Date() }, create: { userId: req.auth.userId, productId: id } });
  res.status(204).send();
}));`,
`experienceRouter.post('/products/:id/view', optionalAuth, asyncHandler(async (req, res) => {
  const id = routeParam(req.params.id, 'id');
  const product = await prisma.product.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  if (!req.auth) return res.status(204).send();
  const existing = await prisma.recentlyViewed.findUnique({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, select: { viewedAt: true } });
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  if (!existing || existing.viewedAt.getTime() < sixHoursAgo) {
    const updated = await prisma.product.updateMany({ where: { id, status: 'ACTIVE' }, data: { viewCount: { increment: 1 } } });
    if (!updated.count) throw new HttpError(404, 'Product not found');
    await prisma.recentlyViewed.upsert({ where: { userId_productId: { userId: req.auth.userId, productId: id } }, update: { viewedAt: new Date() }, create: { userId: req.auth.userId, productId: id } });
  }
  const overflow = await prisma.recentlyViewed.findMany({ where: { userId: req.auth.userId }, orderBy: { viewedAt: 'desc' }, skip: 50, select: { id: true } });
  if (overflow.length) await prisma.recentlyViewed.deleteMany({ where: { id: { in: overflow.map(row => row.id) } } });
  res.status(204).send();
}));`,
'low-write product view tracking');

// Avoid WAL churn when a supplier stock snapshot is unchanged.
replaceOne('inventory',
`export async function setSupplierReportedStock(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  stock: number | null,
) {
  if (stock === null) {
    await tx.supplierProduct.update({
      where: { id: supplierLinkId },
      data: { stock: null, availableStock: null, lastSyncedAt: new Date() },
    });
    return null;
  }

  await tx.$executeRaw\`
    UPDATE "SupplierProduct"
    SET
      "stock" = \${stock},
      "availableStock" = GREATEST(0, \${stock} - "reservedStock"),
      "lastSyncedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = \${supplierLinkId}
  \`;
  const updated = await tx.supplierProduct.findUnique({
    where: { id: supplierLinkId },
    select: { availableStock: true },
  });
  return updated?.availableStock ?? 0;
}`,
`export async function setSupplierReportedStock(
  tx: Prisma.TransactionClient,
  supplierLinkId: string,
  stock: number | null,
) {
  if (stock === null) {
    await tx.$executeRaw\`
      UPDATE "SupplierProduct"
      SET "stock" = NULL, "availableStock" = NULL, "lastSyncedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = \${supplierLinkId}
        AND ("stock" IS NOT NULL OR "availableStock" IS NOT NULL)
    \`;
    return null;
  }

  await tx.$executeRaw\`
    UPDATE "SupplierProduct"
    SET
      "stock" = \${stock},
      "availableStock" = GREATEST(0, \${stock} - "reservedStock"),
      "lastSyncedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = \${supplierLinkId}
      AND (
        "stock" IS DISTINCT FROM \${stock}
        OR "availableStock" IS DISTINCT FROM GREATEST(0, \${stock} - "reservedStock")
      )
  \`;
  const updated = await tx.supplierProduct.findUnique({
    where: { id: supplierLinkId },
    select: { availableStock: true },
  });
  return updated?.availableStock ?? 0;
}`,
'conditional supplier stock snapshots');

// Fail closed if any critical marker is missing.
const v = next.get('vinyasa');
const e = next.get('env');
const x = next.get('experience');
const i = next.get('inventory');
for (const marker of [
  'VINYASA_LEAN_STORAGE_MODE',
  'VINYASA_DB_SIZE_GUARD_MB',
  'VINYASA_LEAN_BATCH_PRODUCTS',
]) if (!e.includes(marker)) throw new Error(`Final validation failed: env missing ${marker}`);
for (const marker of [
  'rawData: Prisma.DbNull',
  'async function assertVinyasaStorageHeadroom',
  "await assertVinyasaStorageHeadroom('image repair')",
  "await assertVinyasaStorageHeadroom('image repair batch')",
  'const supplierMetadataChanged =',
  'const imagesChanged =',
  'const existingSupplierFitments =',
]) if (!v.includes(marker)) throw new Error(`Final validation failed: Vinyasa service missing ${marker}`);
if (v.includes('rawData: row.raw as Prisma.InputJsonValue')) throw new Error('Final validation failed: bulk SupplierProduct rawData persistence remains.');
if ((v.match(/seoTitle:\s*`\$\{row\.name\}/g) || []).length) throw new Error('Final validation failed: importer-generated SEO persistence remains.');
if (v.includes('const clearLegacySeo =') !== v.includes('...clearLegacySeo')) throw new Error('Final validation failed: optional legacy SEO cleanup is only partially installed.');
if (!i.includes('IS DISTINCT FROM')) throw new Error('Final validation failed: supplier inventory still rewrites unchanged stock snapshots.');
if (v.includes("assertVinyasaStorageHeadroom(options.mode === 'STOCK_PRICE'")) throw new Error('Final validation failed: storage guard can still block stock/price sync.');
const syncWindow = functionWindowByName('vinyasa', 'syncVinyasaCatalog');
if (/^\s*await assertVinyasaStorageHeadroom\('(?:catalog job|stock\/price sync)'\);$/m.test(syncWindow.body)) throw new Error('Final validation failed: direct STOCK_PRICE sync can still be blocked by storage guard.');
const modernStarterFinal = functionWindowByName('vinyasa', 'startVinyasaCatalogJob', { optional: true });
const legacyStarterFinal = functionWindowByName('vinyasa', 'startVinyasaImportJob', { optional: true });
if (modernStarterFinal && !modernStarterFinal.body.includes("(input.mode ?? 'FULL') !== 'STOCK_PRICE'")) throw new Error('Final validation failed: modern background STOCK_PRICE job can be blocked by storage guard.');
if (legacyStarterFinal && !legacyStarterFinal.body.includes("assertVinyasaStorageHeadroom('catalog job')")) throw new Error('Final validation failed: legacy FULL import job is missing storage guard.');
if (!modernStarterFinal && !legacyStarterFinal) throw new Error('Final validation failed: no supported Vinyasa background starter exists.');
const modernBatchFinal = functionWindowByName('vinyasa', 'processVinyasaCatalogJobBatch', { optional: true });
const legacyBatchFinal = functionWindowByName('vinyasa', 'resumeVinyasaImportJob', { optional: true });
const batchFinal = modernBatchFinal ?? legacyBatchFinal;
if (!batchFinal || !batchFinal.body.includes("config.importJobMode !== 'STOCK_PRICE' && config.importJobMode !== 'IMAGES'") || !batchFinal.body.includes("assertVinyasaStorageHeadroom('catalog job batch')")) throw new Error('Final validation failed: background catalogue batches are not safely storage-guarded.');
if (!v.includes('const syncHeartbeatDue =')) throw new Error('Final validation failed: bounded supplier sync heartbeat missing.');
if (x.includes('take: 200')) throw new Error('Final validation failed: recently viewed cleanup is still artificially capped.');
for (const marker of ["findFirst({ where: { id, status: 'ACTIVE' }", 'if (!req.auth) return res.status(204).send();', 'skip: 50']) if (!x.includes(marker)) throw new Error(`Final validation failed: experience route missing ${marker}`);

for (const [key, rel] of Object.entries(files)) {
  const before = original.get(key);
  let text = next.get(key);
  if (before.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  if (text !== before) fs.writeFileSync(path.join(root, rel), text, 'utf8');
}

console.log('SANDMAN V3.1.4 lean-storage hardening applied safely.');
for (const change of changes) console.log(`  - ${change}`);
console.log('No Prisma migration, .env, secret, payment setting, supplier-order setting, or bulk database cleanup was performed.');
