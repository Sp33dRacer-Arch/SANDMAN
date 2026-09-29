#!/usr/bin/env node
import fs from 'node:fs';
const read = p => fs.readFileSync(p, 'utf8');
const env = read('src/config/env.ts');
const v = read('src/services/vinyasa.service.ts');
const x = read('src/modules/experience/experience.routes.ts');
const i = read('src/services/supplier-inventory.service.ts');
const patcher = read('scripts/apply-lean-hardening-v3.1.4.mjs');
const filesBlock = patcher.match(/const files = \{([\s\S]*?)\n\};/)?.[1] ?? '';const activeLookup = "const product = await prisma.product.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } });";
const anonymousReturn = 'if (!req.auth) return res.status(204).send();';
const checks = [
  ['lean storage mode defaults on', env.includes('VINYASA_LEAN_STORAGE_MODE: booleanFromEnv.default(true)')],
  ['database size guard default exists', env.includes('VINYASA_DB_SIZE_GUARD_MB') && env.includes('.default(250)')],
  ['lean import batch default exists', env.includes('VINYASA_LEAN_BATCH_PRODUCTS') && env.includes('.default(500)')],
  ['SupplierProduct raw payload writes removed', !v.includes('rawData: row.raw as Prisma.InputJsonValue')],
  ['SupplierProduct rawData is explicitly nulled', (v.match(/rawData: Prisma\.DbNull/g) || []).length >= 3],
  ['dynamic SEO replaces importer SEO persistence', !(v.match(/seoTitle:\s*`\$\{row\.name\}/g) || []).length],
  ['optional legacy SEO cleanup is internally consistent', v.includes('const clearLegacySeo =') === v.includes('...clearLegacySeo')],
  ['unchanged product images avoid delete/recreate churn', v.includes('const imagesChanged =') && v.includes('if (imagesChanged)')],
  ['unchanged supplier fitment avoids delete/recreate churn', v.includes('const existingSupplierFitments =') && v.includes('existingIds.size === ids.size')],
  ['database size uses read-only pg_database_size', v.includes('pg_database_size(current_database())')],
  ['catalog job starter supports both worker generations safely', v.includes("if ((input.mode ?? 'FULL') !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog job')") || (v.includes('startVinyasaImportJob') && v.includes("await assertVinyasaStorageHeadroom('catalog job')"))],
  ['image repair guard present', v.includes("assertVinyasaStorageHeadroom('image repair')")],
  ['image repair rechecks storage every batch', v.includes("assertVinyasaStorageHeadroom('image repair batch')")],
  ['catalog page guard present', v.includes("options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import')")],
  ['stock/price sync cannot be blocked by direct storage guard', !v.includes("assertVinyasaStorageHeadroom(options.mode === 'STOCK_PRICE'") && v.includes("options.mode !== 'STOCK_PRICE') await assertVinyasaStorageHeadroom('catalog import')")],
  ['background catalogue batches recheck storage without blocking STOCK_PRICE', v.includes("config.importJobMode !== 'STOCK_PRICE' && config.importJobMode !== 'IMAGES'") && v.includes("assertVinyasaStorageHeadroom('catalog job batch')")],
  ['lean worker batches cap transient WAL', v.includes('env.VINYASA_LEAN_STORAGE_MODE ? env.VINYASA_LEAN_BATCH_PRODUCTS')],
  ['unchanged Vinyasa rows retain bounded sync freshness', v.includes('const syncHeartbeatDue =') && v.includes('supplierMetadataChanged || priceChanged || syncHeartbeatDue')],
  ['unchanged supplier stock snapshots avoid UPDATEs', i.includes('IS DISTINCT FROM') && i.includes('AND ("stock" IS NOT NULL OR "availableStock" IS NOT NULL)')],
  ['anonymous product views validate active product before returning', x.includes(activeLookup) && x.indexOf(activeLookup) < x.indexOf(anonymousReturn)],
  ['anonymous product views remain write-free', x.includes(anonymousReturn)],
  ['logged-in view writes are throttled', x.includes('sixHoursAgo')],
  ['recently viewed is strictly pruned beyond 50', x.includes('skip: 50') && x.includes('recentlyViewed.deleteMany') && !x.includes('take: 200')],
  ['patcher uses function-name structural patching', patcher.includes('functionWindowByName') && patcher.includes('ensureLineAfterInFunction')],
  ['patcher supports modern and legacy Vinyasa workers', patcher.includes('startVinyasaCatalogJob') && patcher.includes('startVinyasaImportJob') && patcher.includes('processVinyasaCatalogJobBatch') && patcher.includes('resumeVinyasaImportJob')],
  ['patcher targets no Prisma schema or migration files', !filesBlock.includes('prisma/') && !filesBlock.includes('migration')],
];
let failed = 0;
for (const [label, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); if (!ok) failed++; }
if (failed) { console.error(`SANDMAN V3.1.4 lean-storage audit failed (${failed}/${checks.length}).`); process.exit(1); }
console.log(`SANDMAN V3.1.4 lean-storage audit passed (${checks.length}/${checks.length}).`);
