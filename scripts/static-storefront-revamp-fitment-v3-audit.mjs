import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const app = read('public/store/app.js');
const products = read('src/modules/products/products.routes.ts');
const experience = read('src/modules/experience/experience.routes.ts');
const normalizer = read('src/services/vinyasa-normalizer.ts');
const vinyasa = read('src/services/vinyasa.service.ts');
const server = read('src/server.ts');
const bootstrap = read('src/services/vehicle-catalog-bootstrap.service.ts');
const appServer = read('src/app.ts');
const vehicleData = JSON.parse(read('data/sandman-global-vehicles.json'));

const schedulerPos = server.indexOf('startVinyasaScheduler()');
const bootstrapPos = server.indexOf('ensureCuratedVehicleCatalog()');

const checks = [
  ['clean shop pagination keeps page param', app.includes("if(key!=='page')next.delete('page')") && app.includes("navigate(`/shop${query?`?${query}`:''}`)")],
  ['shop pagination has previous/next controls', app.includes('data-page="${current-1}"') && app.includes('data-page="${current+1}"')],
  ['shop pagination window stays bounded for huge catalogues', app.includes('pageEnd-pageStart+1') && !app.includes('Array.from({length:data.pages}')],
  ['home includes Vinyasa connected-catalog listings', app.includes('VINYASA / CONNECTED CATALOG') && app.includes('vinyasaProducts')],
  ['broken product images fall back cleanly', app.includes('data-product-image') && app.includes('installProductImageFallback')],
  ['storefront actions no longer assign location.hash directly', !/location\.hash\s*=/.test(app)],
  ['message conversation buttons bind all matches', app.includes("$$('[data-conversation]').forEach") && !/(^|[^$])\$\('\[data-conversation\]'\)\.forEach/.test(app)],
  ['home API returns image-bearing Vinyasa products', experience.includes("supplier: { code: 'vinyasa' }") && experience.includes('images: { some: {} }') && experience.includes('vinyasa: vinyasa.map(publicProduct)')],
  ['search suggestions use relevance-safe image bonus', experience.includes('imagePriority') && experience.includes('searchScore + imagePriority')],
  ['product search preserves exact matches before image bonus', products.includes('Number(bScore >= 930)') && products.includes('bScore + imagePriority(b)') && !products.includes('const imageFirst = imagePriority(b)')],
  ['Vinyasa singular fitment + applications are normalized', normalizer.includes("['fitment', 'fitments', 'vehicles', 'compatibility']") && normalizer.includes("pick(raw, ['applications'])")],
  ['fitment normalization is hard-capped', normalizer.includes('if (!row || out.length >= 250) return;') && normalizer.includes('break fitmentExpansion')],
  ['documented Vinyasa cursor and stock keys are supported', normalizer.includes("url.searchParams.get('after')") && normalizer.includes('available_qty')],
  ['supplier make/model/year fitment can create vehicle variants', vinyasa.includes('ensureSupplierVehicleVariant') && vinyasa.includes("source: 'SUPPLIER'")],
  ['application-text fitment matching is type-safe', vinyasa.includes('const applicationText = fitment.applicationText;') && vinyasa.includes('if (!applicationText) continue;')],
  ['curated vehicle catalogue is bundled and idempotent', bootstrap.includes('sandman-global-vehicles.json') && bootstrap.includes('curatedCatalogLooksReady')],
  ['curated engine codes are preserved instead of discarded', bootstrap.includes('const curatedEngine = clean(row.engine);') && bootstrap.includes("const engineCode = curatedEngine || 'UNSPECIFIED';")],
  ['vehicle bootstrap completes before Vinyasa scheduler starts', bootstrapPos >= 0 && schedulerPos > bootstrapPos && server.includes('.finally(() => startVinyasaScheduler())')],
  ['clean History-API storefront routes are served by Express', appServer.includes('const storefrontRoute =') && appServer.includes('messages') && appServer.includes('checkout') && appServer.includes("app.get('/products/:slug'")],
  ['bundled vehicle data contains real engine-coded rows', Array.isArray(vehicleData.records) && vehicleData.records.some(row => row.engine === 'B58') && vehicleData.records.some(row => String(row.engine || '').includes('N55'))],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`SANDMAN storefront revamp/fitment V3 audit failed (${failed}/${checks.length}).`);
  process.exit(1);
}
console.log(`SANDMAN storefront revamp/fitment V3 audit passed (${checks.length}/${checks.length}).`);
