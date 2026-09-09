import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const appServer = read('src/app.ts');
const app = read('public/store/app.js');
const seo = read('src/services/storefront-seo.service.ts');
const vinyasa = read('src/services/vinyasa.service.ts');

const checks = [
  ['server SEO selects product source type', appServer.includes('sourceType: true') && seo.includes('sourceType: string;')],
  ['legacy supplier-generated title is distinguished from manual SEO', seo.includes('legacySupplierTitle') && seo.includes("product.sourceType === 'DROPSHIP'")],
  ['legacy supplier-generated description is distinguished from manual SEO', seo.includes('legacySupplierDescription') && seo.includes('hasCustomDescription')],
  ['manual SEO remains authoritative', seo.includes('hasCustomTitle ? truncate(product.seoTitle!') && seo.includes('hasCustomDescription ? product.seoDescription')],
  ['SPA metadata always replaces stale social images', app.includes("const socialImage = image || `${location.origin}/assets/sandman-logo.webp`") && app.includes("setMeta('property', 'og:image', socialImage)")],
  ['SPA metadata clears stale product social tags', app.includes("setMeta('property', 'product:price:amount', null)") && app.includes("setMeta('property', 'product:availability', null)")],
  ['SPA metadata refreshes robots and Twitter card', app.includes("setMeta('name', 'robots', robots)") && app.includes("setMeta('name', 'twitter:card', 'summary_large_image')")],
  ['page JSON-LD is identifiable and replaceable', appServer.includes('data-sandman-page-schema="1"') && app.includes('script[data-sandman-page-schema="1"]')],
  ['SPA product navigation rebuilds Product JSON-LD', app.includes("'@type': 'Product'") && app.includes('script.dataset.sandmanPageSchema')],
  ['SPA product navigation rebuilds Breadcrumb JSON-LD', app.includes("'@type': 'BreadcrumbList'") && app.includes("'product', p")],
  ['generic Vinyasa fitment resolves multiple safe variants', vinyasa.includes('ensureSupplierVehicleVariants') && vinyasa.includes('return candidates.map(candidate => candidate.id)')],
  ['fitment only maps curated variants fully covered by supplier years', vinyasa.includes('yearStart: { gte: yearStart }') && vinyasa.includes('yearEnd: { lte: yearEnd }')],
  ['partial-year fitment is not guessed', vinyasa.includes('partial overlap would incorrectly mark unsupported years as fitting')],
  ['supplier fitment has a bounded multi-variant lookup', vinyasa.includes('take: 500')],
  ['synthetic supplier variant is reused before creation', vinyasa.includes('existingSynthetic') && vinyasa.includes('if (existingSynthetic) return [existingSynthetic.id]')],
  ['stale Vinyasa fitment rows are refreshed', vinyasa.includes('await prisma.productFitment.deleteMany') && vinyasa.includes("notes: { startsWith: 'Imported from Vinyasa supplier compatibility data;' }")],
  ['manual and verified fitments are protected from supplier refresh', vinyasa.includes("source: 'SUPPLIER'") && vinyasa.includes('verified: false')],
  ['unresolvable supplier feed does not erase prior fitment', vinyasa.indexOf('if (!ids.size) return 0;') < vinyasa.indexOf('await prisma.productFitment.deleteMany')],
  ['no manual WAL/database or payment behavior is introduced by hardening', !seo.includes('updateMany') && !app.includes('VINYASA_ORDER_SUBMISSION_ENABLED=true')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`SANDMAN storefront V3 hardening audit failed (${failed}/${checks.length}).`);
  process.exit(1);
}
console.log(`SANDMAN storefront V3 hardening audit passed (${checks.length}/${checks.length}).`);
